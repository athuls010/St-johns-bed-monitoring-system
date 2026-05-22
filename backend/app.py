from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
import pandas as pd
import numpy as np
import requests
from datetime import datetime, timedelta, timezone
import threading
from dotenv import load_dotenv
from docx import Document

load_dotenv()

app = Flask(__name__, static_folder='../frontend', static_url_path='/')
CORS(app)  # Enable CORS for all routes

# Serve static files
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/assets/<path:path>')
def send_assets(path):
    return send_from_directory('../assets', path)

# ─── Configuration ────────────────────────────────────────────────────────────
_SCRIPT_URL   = os.environ.get("GOOGLE_SCRIPT_URL", "")
_HISTORY_SCRIPT_URL = os.environ.get("GOOGLE_HISTORY_SCRIPT_URL", _SCRIPT_URL)
_DEPT_STATS_SCRIPT_URL = os.environ.get("GOOGLE_DEPT_STATS_SCRIPT_URL", "")
_SCRIPT_TOKEN = os.environ.get("GOOGLE_SCRIPT_TOKEN", "")

# ─── Caching Configuration ──────────────────────────────────────────────────
_CACHE_TTL = timedelta(seconds=60)
_HISTORY_CACHE_TTL = timedelta(seconds=60)
_SHEET_CACHE = {}  # tab_name -> {"data": DataFrame/List, "time": datetime}
_CACHE_LOCK = threading.Lock()
_HISTORY_LOCK = threading.Lock()

def _get_cached_data(key, ttl=_CACHE_TTL):
    """Retrieve data from global cache if valid."""
    with _CACHE_LOCK:
        cached = _SHEET_CACHE.get(key)
        if cached and cached["data"] is not None:
            if datetime.now() - cached["time"] < ttl:
                return cached["data"]
    return None

def _set_cached_data(key, data):
    """Save data to global cache."""
    with _CACHE_LOCK:
        _SHEET_CACHE[key] = {"data": data, "time": datetime.now()}

def _clear_cache(key=None):
    """Clear specific or all cache entries."""
    with _CACHE_LOCK:
        if key:
            _SHEET_CACHE.pop(key, None)
        else:
            _SHEET_CACHE.clear()

# ─── Google Sheets Integration Helpers ────────────────────────────────────────
def _sheet_to_df(tab_name, custom_url=None, force_refresh=False):
    """Read data from Google Apps Script Web App into a DataFrame with caching."""
    # Only cache if it's the main script and not forced
    if not custom_url and not force_refresh:
        cached_df = _get_cached_data(tab_name)
        if cached_df is not None:
            return cached_df.copy()

    target_url = custom_url or _SCRIPT_URL
    if not target_url:
        return None

    try:
        params = {"sheet": tab_name}
        if _SCRIPT_TOKEN:
            params["token"] = _SCRIPT_TOKEN
        
        response = requests.get(target_url, params=params, timeout=30)
        if response.status_code == 200:
            try:
                data = response.json()
                df = pd.DataFrame(data) if isinstance(data, list) and len(data) > 0 else pd.DataFrame()
                
                # Cache the raw result if it's from the main script
                if not custom_url:
                    _set_cached_data(tab_name, df.copy())
                return df
            except ValueError:
                print(f"[Sheets APP] Non-JSON response on '{tab_name}': {response.text[:200]}")
                return pd.DataFrame()
        return pd.DataFrame()
    except Exception as e:
        print(f"[Sheets APP] Read error on '{tab_name}': {e}")
        return pd.DataFrame()

def _df_to_sheet(df, tab_name, custom_url=None, action="append"):
    """Write a full DataFrame back to a Google Sheet via Apps Script."""
    target_url = custom_url or _SCRIPT_URL
    if not target_url:
        return False
    try:
        # Prevent auto-formatting issues for specific columns
        for col in ['Date', 'Timestamp', 'Last_Update']:
            if col in df.columns:
                df[col] = df[col].astype(str)
        
        df = df.fillna("")  # Avoid NaN issues in JSON
        payload = {
            "sheetName": tab_name,
            "data": df.to_dict(orient="records"),
            "action": action
        }
        if _SCRIPT_TOKEN:
            payload["token"] = _SCRIPT_TOKEN
        
        response = requests.post(target_url, json=payload, timeout=20)
        return response.status_code == 200
    except Exception as e:
        print(f"[Sheets APP] Write error on '{tab_name}' at {target_url}: {e}")
        return False

def _append_to_history(record):
    """Directly append a single record to the History spreadsheet."""
    with _HISTORY_LOCK:
        try:
            # 1. Calculate dynamic tab name (e.g., Hist_2026_03_11)
            entry_date = record.get("Date", "Unknown")
            safe_date = entry_date.replace("-", "_").replace(".", "_")
            tab_name = f"Hist_{safe_date}"

            # 2. Convert record to a list of one dict for the payload
            # The script will handle creating the sheet and headers if missiong.
            df_record = pd.DataFrame([record])
            
            # 3. Save to the history URL (Appending)
            success = _df_to_sheet(df_record, tab_name, custom_url=_HISTORY_SCRIPT_URL, action="append")
            if success:
                print(f"[History] Successfully appended record to {tab_name} for {record.get('Ward_Name', 'Unknown')}")
            else:
                print(f"[History] Write failure for {record.get('Ward_Name')} on {tab_name}")
        except Exception as e:
            print(f"[History] Exception in record append: {e}")

def _archive_dept_stats(entry_date):
    """Calculate and archive department-wise NMC performance for the day."""
    if not _DEPT_STATS_SCRIPT_URL:
        return

    try:
        print(f"[DeptStats] Starting archival for {entry_date}...")
        # 1. Load data
        df_beds = load_data()
        depts = _get_depts_data()
        
        if df_beds is None or df_beds.empty:
            print("[DeptStats] Aborting: BedStatus is empty.")
            return
        if not depts:
            print("[DeptStats] Aborting: No departments found.")
            return

        # 2. Daily Tab Name
        safe_date = entry_date.replace("-", "_").replace(".", "_")
        tab_name = f"Dept_{safe_date}"

        # 3. Calculate stats per department
        stats_list = []

        for d in depts:
            s_name = d['name']
            s_lower = s_name.lower()
            # Log all departments as-is (no skipping or clubbing)
            nmc_beds = d.get('nmc_beds', 0)

            occupied = 0
            for _, w in df_beds.iterrows():
                # Own Specialty
                w_spec = str(w.get('Specialty', '')).strip().lower()
                if w_spec == s_lower:
                    occupied += (int(pd.to_numeric(w.get('Occupancy', 0), errors='coerce') or 0))
                
                # Cross Specialty
                cross_str = w.get('Cross_Specialty_Name', '')
                if cross_str and isinstance(cross_str, str) and cross_str.startswith('{'):
                    try:
                        import json
                        cross = json.loads(cross_str)
                        for spec_k, count in cross.items():
                            if spec_k.lower().startswith(s_lower):
                                occupied += (int(pd.to_numeric(count, errors='coerce') or 0))
                    except:
                        pass
            
            vacant = max(0, nmc_beds - occupied)
            pct = round((occupied / nmc_beds) * 100, 1) if nmc_beds > 0 else 0
            
            stats_list.append({
                "Department": s_name,
                "NMC_Beds": nmc_beds,
                "Occupied": occupied,
                "Vacant": vacant,
                "Occupancy_Pct": f"{pct}%",
                "Last_Update": "auto" # Script will fill IST
            })

        if not stats_list:
            return

        # 4. Save to the Dept Stats URL (Overwrite full sheet for the day)
        df_stats = pd.DataFrame(stats_list)
        success = _df_to_sheet(df_stats, tab_name, custom_url=_DEPT_STATS_SCRIPT_URL, action="overwrite")
        if success:
            print(f"[DeptStats] Successfully archived stats to {tab_name}")
        else:
            print(f"[DeptStats] Write failure for {tab_name}")

    except Exception as e:
        print(f"[DeptStats] Error: {e}")

# ─── Data Loading / Saving ───────────────────────────────────────────────────
def load_data():
    """Load bed-status from Google Sheets with optimized caching."""
    df_beds = _sheet_to_df("BedStatus")
    if df_beds is not None and not df_beds.empty:
        # Numeric parsing
        cols_to_parse = ["sanctioned_beds", "Occupancy", "Vacant_Beds", 
                         "External_Specialty_Patients", "Total_Occupied", "Occupancy_Percentage"]
        for col in cols_to_parse:
            if col in df_beds.columns:
                df_beds[col] = pd.to_numeric(df_beds[col], errors="coerce").fillna(0)
            else:
                df_beds[col] = 0
        
        # Force calculation of Total_Occupied if missing or to ensure refresh
        df_beds["Total_Occupied"] = df_beds["Occupancy"] + df_beds["External_Specialty_Patients"]

        # Calculate vacancies and percentages
        if "sanctioned_beds" in df_beds.columns:
            mask = df_beds["sanctioned_beds"] > 0
            df_beds.loc[mask, "Occupancy_Percentage"] = (df_beds.loc[mask, "Total_Occupied"] / df_beds.loc[mask, "sanctioned_beds"]) * 100
            df_beds["Vacant_Beds"] = (df_beds["sanctioned_beds"] - df_beds["Total_Occupied"]).clip(lower=0)

        # Deduplicate
        if "Ward_Name" in df_beds.columns:
            df_beds["Ward_Name"] = df_beds["Ward_Name"].astype(str).str.strip()
            df_beds = df_beds.drop_duplicates(subset=["Ward_Name"], keep="last")

        return df_beds
    return pd.DataFrame()

def save_beds_data(df):
    """Save bed-status DataFrame to Sheets and clear cache."""
    # Immediately update cache for local instance
    _set_cached_data("BedStatus", df.copy())
    
    if _SCRIPT_URL:
        if os.environ.get("VERCEL"):
            _df_to_sheet(df, "BedStatus")
        else:
            threading.Thread(target=_df_to_sheet, args=(df, "BedStatus")).start()

def get_all_users():
    """Load user credentials with caching."""
    df_users = _sheet_to_df("Users")

    users = {
        "admin": {"name": "Administrator", "role": "admin", "password": "admin@2025", "ward": "All"},
        "nurse": {"name": "General Nurse", "role": "nurse", "password": "nurse@2025", "ward": "All"},
        "nmc": {"name": "NMC Admin", "role": "nmc", "password": "nmc@2025", "ward": "All"}
    }
    if df_users is not None and not df_users.empty:
        for _, row in df_users.iterrows():
            uid = str(row.get('User_ID', '')).strip().lower()
            if not uid or uid == 'admin': continue
            users[uid] = {
                "name": f"Nurse — {row.get('Ward_Name', 'Unknown')}",
                "role": str(row.get('Role', 'nurse')).strip().lower(),
                "ward": str(row.get('Ward_Name', '')),
                "password": str(row.get('Password', '')).strip()
            }
    return users

# ─── API Endpoints ────────────────────────────────────────────────────────────

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    username = str(data.get('username', '')).strip().lower()
    password = str(data.get('password', '')).strip()
    
    users = get_all_users()
    if username in users:
        if users[username]['password'] == password:
            user_info = {k: v for k, v in users[username].items() if k != 'password'}
            return jsonify({"success": True, "user": user_info})
    return jsonify({"success": False, "message": "Invalid username or password"}), 401

@app.route('/api/bed-status', methods=['GET'])
def get_bed_status():
    df = load_data()
    if df.empty:
        return jsonify([])
    return jsonify(df.to_dict(orient='records'))

@app.route('/api/departments', methods=['GET'])
@app.route('/api/departments')
def get_departments():
    """API wrapper for _get_depts_data."""
    return jsonify(_get_depts_data())

def _get_depts_data():
    """Logic to fetch unique departments/specialties with unit counts."""
    # Try Department sheet first
    df_depts = _sheet_to_df("Department")
    if df_depts is not None and not df_depts.empty and "Speciality" in df_depts.columns:
        # Use 'Units' column if it exists, otherwise default to 1
        has_units = "Units" in df_depts.columns
        depts = []
        for _, row in df_depts.iterrows():
            spec = str(row["Speciality"]).strip()
            if not spec: continue
            
            units = 1
            if has_units:
                try:
                    units = int(pd.to_numeric(row["Units"], errors="coerce") or 1)
                except:
                    units = 1
            
            nmc_beds = 0
            for col in ["Beds", "NMC_Beds", "NMC Beds", "NMC"]:
                if col in df_depts.columns:
                    try:
                        nmc_beds = int(pd.to_numeric(row[col], errors="coerce") or 0)
                        break
                    except:
                        continue

            depts.append({"name": spec, "units": units, "nmc_beds": nmc_beds})
            
        # Return unique by name, taking max units and max nmc_beds
        unique_depts = {}
        for d in depts:
            name = d["name"]
            if name not in unique_depts:
                unique_depts[name] = d
            else:
                # Keep the max unit count, and the MAX nmc_beds
                if d["units"] > unique_depts[name]["units"]:
                    unique_depts[name]["units"] = d["units"]
                if d["nmc_beds"] > unique_depts[name]["nmc_beds"]:
                    unique_depts[name]["nmc_beds"] = d["nmc_beds"]
        
        return sorted(list(unique_depts.values()), key=lambda x: x["name"])
    
    # Fallback to BedStatus
    df_beds = load_data()
    if not df_beds.empty and "Specialty" in df_beds.columns:
        depts_unique = [str(s).strip() for s in df_beds["Specialty"].unique() if s]
        return [{"name": d, "units": 1, "nmc_beds": 0} for d in sorted(depts_unique)]
    
    return []
    
    # Fallback to BedStatus (usually doesn't have units info)
    df_beds = load_data()
    if not df_beds.empty and "Specialty" in df_beds.columns:
        depts = [str(s).strip() for s in df_beds["Specialty"].unique() if s]
        return jsonify([{"name": d, "units": 1} for d in sorted(depts)])
    
    return jsonify([])

@app.route('/api/metrics', methods=['GET'])
def get_metrics():
    df = load_data()
    if df.empty:
        return jsonify({"total_beds": 0, "occupied": 0, "vacant": 0})
    
    total = int(df['sanctioned_beds'].sum())
    occupied = int(df['Total_Occupied'].sum())
    vacant = max(0, total - occupied)
    
    # Calculate NMC total from Departments
    nmc_total = 0
    try:
        df_depts = _sheet_to_df("Department")
        if df_depts is not None and not df_depts.empty:
            for col in ["Beds", "NMC_Beds", "NMC Beds", "NMC"]:
                if col in df_depts.columns:
                    nmc_total = int(pd.to_numeric(df_depts[col], errors="coerce").sum() or 0)
                    break
    except:
        pass

    return jsonify({
        "total_beds": total,
        "occupied": occupied,
        "vacant": vacant,
        "nmc_total": nmc_total,
        "occupancy_rate": round((occupied / total * 100), 1) if total > 0 else 0
    })

@app.route('/api/ward-entry', methods=['POST'])
def ward_entry():
    data = request.get_json()
    ward_name = data.get('Ward_Name')
    specialties = data.get('specialties', []) # List of {specialty, unit, count}
    
    if not ward_name:
        return jsonify({"success": False, "message": "Ward Name is required"}), 400
    
    df = load_data()
    if ward_name not in df['Ward_Name'].values:
        return jsonify({"success": False, "message": "Ward not found"}), 404
    
    idx = df[df['Ward_Name'] == ward_name].index[0]
    
    # Update simple fields
    for field in ['sanctioned_beds', 'Notes', 'Doctor_InCharge']:
        if field in data and field in df.columns:
            df.at[idx, field] = data[field]

    common_ward_bed_count = int(data.get('common_ward_bed_count', 0) or 0)
    common_ward_bed_count = max(0, common_ward_bed_count)
    if 'Common_Ward_Bed_Count' not in df.columns:
        df['Common_Ward_Bed_Count'] = 0
    df.at[idx, 'Common_Ward_Bed_Count'] = common_ward_bed_count
    
    # Process specialties
    import json
    cross_spec_dict = {}
    external_total = 0
    own_occ = 0
    own_spec = str(df.at[idx, 'Specialty']).strip().lower()

    for item in specialties:
        spec = str(item.get('specialty', '')).strip()
        count = int(item.get('count', 0))
        unit = str(item.get('unit', '')).strip()
        
        if not spec or count <= 0: continue
        
        if spec.lower() == own_spec:
            own_occ += count
        else:
            key = f"{spec} {unit}".strip() if unit else spec
            cross_spec_dict[key] = cross_spec_dict.get(key, 0) + count
            external_total += count
            
    df.at[idx, 'Occupancy'] = own_occ
    df.at[idx, 'External_Specialty_Patients'] = external_total
    df.at[idx, 'Total_Occupied'] = own_occ + external_total
    df.at[idx, 'Cross_Specialty_Name'] = json.dumps(cross_spec_dict) if cross_spec_dict else ""
    
    # Save EMPID to live status
    emp_id = data.get('emp_id', 'Unknown')
    if 'EMPID' in df.columns:
        df.at[idx, 'EMPID'] = emp_id
    
    # Recalculate vacant and percentage
    sanc_val = float(df.at[idx, 'sanctioned_beds'])
    df.at[idx, 'Vacant_Beds'] = max(0, sanc_val - (own_occ + external_total))
    if sanc_val > 0:
        df.at[idx, 'Occupancy_Percentage'] = ((own_occ + external_total) / sanc_val) * 100
    
    save_beds_data(df)
    # Clear caches that depend on BedStatus or History
    _clear_cache("HistoryCombined")
    _clear_cache("Department")


    # --- HISTORY APPEND LOGIC ---
    try:
        ist = timezone(timedelta(hours=5, minutes=30))
        now_ist = datetime.now(ist)
        emp_id = data.get('emp_id', 'Unknown')
        
        # Calculate shift-adjusted date for history grouping
        frontend_date = data.get('entry_date')
        calendar_today = now_ist.strftime("%Y-%m-%d")
        
        # If time is between 00:00 (Midnight) and 09:59 AM, group under Yesterday's date
        if now_ist.hour < 10:
            logical_today = (now_ist - timedelta(days=1)).strftime("%Y-%m-%d")
        else:
            logical_today = calendar_today
            
        # If frontend didn't send a date, or if it sent today's calendar date, apply our shift boundary
        if not frontend_date or frontend_date == calendar_today:
            entry_date = logical_today
        else:
            # The nurse manually picked a specific past/future date, respect it
            entry_date = frontend_date
        # 4. Final Row with placeholders for Script to fill timestamps
        history_record = {
            "Date": entry_date, 
            "Timestamp": "auto", # Script will fill IST
            "Ward_Name": ward_name,
            "EMPID": emp_id,
            "Total_Sanctioned": sanc_val,
            "Own_Occupied": own_occ,
            "Cross_Specialty_Occupied": external_total,
            "Total_Occupied": own_occ + external_total,
            "Vacant": max(0, sanc_val - (own_occ + external_total)),
            "Common_Ward_Bed_Count": common_ward_bed_count,
            "Cross_Specialty_Details": json.dumps(cross_spec_dict) if cross_spec_dict else ""
        }
        # On Vercel (Serverless), we must run this synchronously
        if os.environ.get("VERCEL"):
            _append_to_history(history_record)
            _archive_dept_stats(entry_date)
        else:
            threading.Thread(target=_append_to_history, args=(history_record,)).start()
            threading.Thread(target=_archive_dept_stats, args=(entry_date,)).start()
    except Exception as e:
        print(f"[History] Failed to initiate record: {e}")
    # ----------------------------

    return jsonify({"success": True})

@app.route('/api/transfer', methods=['POST'])
def transfer_patients():
    data = request.get_json()
    source_name = data.get('source_ward')
    target_name = data.get('target_ward')
    count = int(data.get('count', 0))
    
    if not source_name or not target_name or count <= 0:
        return jsonify({"success": False, "message": "Invalid transfer parameters"}), 400
    
    df = load_data()
    if source_name not in df['Ward_Name'].values or target_name not in df['Ward_Name'].values:
        return jsonify({"success": False, "message": "One or both wards not found"}), 404
    
    source_idx = df[df['Ward_Name'] == source_name].index[0]
    target_idx = df[df['Ward_Name'] == target_name].index[0]
    
    # Check if source has enough patients
    source_occupied = df.at[source_idx, 'Occupancy']
    if source_occupied < count:
        return jsonify({"success": False, "message": "Source ward has insufficient patients"}), 400
    
    # Perform transfer
    df.at[source_idx, 'Occupancy'] -= count
    df.at[target_idx, 'Occupancy'] += count
    
    # Recalculate Total_Occupied and Vacant_Beds for both
    for idx in [source_idx, target_idx]:
        occ = df.at[idx, 'Occupancy']
        ext = df.at[idx, 'External_Specialty_Patients']
        sanc = df.at[idx, 'sanctioned_beds']
        df.at[idx, 'Total_Occupied'] = occ + ext
        df.at[idx, 'Vacant_Beds'] = max(0, sanc - (occ + ext))
        save_beds_data(df)
    # Clear caches for metrics/NMC totals
    _clear_cache("Department")
    _clear_cache("HistoryCombined")


    # --- TRIGGER ARCHIVAL ---
    try:
        ist = timezone(timedelta(hours=5, minutes=30))
        now_ist = datetime.now(ist)
        # Calculate shift-adjusted date (same logic as ward-entry)
        if now_ist.hour < 10:
            entry_date = (now_ist - timedelta(days=1)).strftime("%Y-%m-%d")
        else:
            entry_date = now_ist.strftime("%Y-%m-%d")

        if os.environ.get("VERCEL"):
            _archive_dept_stats(entry_date)
        else:
            threading.Thread(target=_archive_dept_stats, args=(entry_date,)).start()
    except Exception as e:
        print(f"[Transfer] Archival trigger failed: {e}")

    return jsonify({"success": True})

@app.route('/api/history', methods=['GET'])
def get_history():
    """Fetch historical records with caching across daily tabs."""
    cache_key = "HistoryCombined"
    cached_data = _get_cached_data(cache_key, ttl=_HISTORY_CACHE_TTL)
    if cached_data is not None:
        return jsonify(cached_data)

    ist = timezone(timedelta(hours=5, minutes=30))
    now_ist = datetime.now(ist)
    
    # Check the last 15 days (a 2-week rolling window)
    tabs_to_check = [f"Hist_{(now_ist - timedelta(days=i)).strftime('%Y_%m_%d')}" for i in range(15)]
    tabs_to_check.extend(["History", "Daily_History"])  # Fallbacks
    
    all_records = []
    seen_ids = set()
    
    def fetch_tab(tab):
        try:
            df = _sheet_to_df(tab, custom_url=_HISTORY_SCRIPT_URL)
            if df is not None and not df.empty:
                return df.to_dict(orient='records')
        except Exception as e:
            print(f"[History API] Skipping {tab} due to error: {e}")
        return []

    import concurrent.futures
    # Use ThreadPoolExecutor to load up to 10 sheets simultaneously 
    # This prevents the backend request from taking too long if we load 15 sheets
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = executor.map(fetch_tab, tabs_to_check)
        
        for records in results:
            for r in records:
                t_val = r.get('Timestamp')
                w_val = r.get('Ward_Name')
                if t_val and w_val:
                    rid = f"{w_val}_{t_val}"
                    if rid not in seen_ids:
                        all_records.append(r)
                        seen_ids.add(rid)
    
    # Update cache
    _set_cached_data(cache_key, all_records)
    return jsonify(all_records)

if __name__ == '__main__':
    app.run(debug=True, port=5000)
