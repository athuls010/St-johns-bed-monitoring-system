from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_cors import CORS
import os
import pandas as pd
import numpy as np
import requests
from datetime import datetime, timedelta, timezone
import threading
import io
from dotenv import load_dotenv
from docx import Document
import math
import random
import string

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
_PASTOR_SCRIPT_URL = os.environ.get("PASTOR_SCRIPT_URL", "")

# ─── Caching Configuration ──────────────────────────────────────────────────
_CACHE_TTL = timedelta(seconds=60)
_HISTORY_CACHE_TTL = timedelta(seconds=60)
_USERS_CACHE_TTL = timedelta(hours=1) # Cache users for an hour
_SHEET_CACHE = {}  # tab_name -> {"data": DataFrame/List, "time": datetime}

_CACHE_LOCK = threading.Lock()
_HISTORY_LOCK = threading.Lock()
_WEEKLY_SUMMARY_TTL = timedelta(minutes=5)

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
def _sheet_to_df(tab_name, custom_url=None, force_refresh=False, timeout=30):
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
        params = {"sheet": tab_name, "tab": tab_name}
        if _SCRIPT_TOKEN:
            params["token"] = _SCRIPT_TOKEN
        
        response = requests.get(target_url, params=params, timeout=timeout)
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
            pw_occ = 0
            cw_occ = 0

            for _, w in df_beds.iterrows():
                # Own Specialty
                w_spec = str(w.get('Specialty', '')).strip().lower()
                w_pw = int(w.get('PW_Occupied', 0))
                w_cw = int(w.get('CW_Occupied', 0))

                if w_spec == s_lower:
                    occupied += (int(pd.to_numeric(w.get('Occupancy', 0), errors='coerce') or 0))
                    # We need to distribute PW/CW proportionally or use specific data if available
                    # For own specialty, we assume it's part of the ward's PW/CW
                    # This is tricky because the ward entry doesn't split PW/CW per specialty in the summary
                    # But the entry form DOES have it.
                    # Wait! I should use the cross-specialty details for better accuracy.
                    pass 

            # Actually, it's better to reconstruct from the cross-specialty JSON if I want PW/CW per dept
            # because the ward-level PW/CW includes all specialties.
            # But the 'Specialties' in ward entry includes pw_count and cw_count per row!
            # Let's check how I store it in BedStatus.
            # I don't store the full breakdown in BedStatus except in 'Cross_Specialty_Name' JSON.
            
            # Let's use the 'Cross_Specialty_Name' (which I renamed to Details in history, but it's Name in BedStatus)
            for _, w in df_beds.iterrows():
                cross_raw = w.get('Cross_Specialty_Name', '')
                if not cross_raw: continue
                try:
                    import json
                    cross = json.loads(cross_raw) if isinstance(cross_raw, str) else cross_raw
                    for key, count in cross.items():
                        # key is "Spec Unit|Type" (e.g. "Cardiology Unit 1|private")
                        if "|" in key:
                            spec_part, type_part = key.split("|")
                            if spec_part.lower().startswith(s_lower):
                                occupied += count
                                if type_part == 'private': pw_occ += count
                                else: cw_occ += count
                        else:
                            # Fallback for old records
                            if key.lower().startswith(s_lower):
                                occupied += count
                                cw_occ += count # Default to common
                except:
                    pass
            
            vacant = max(0, nmc_beds - occupied)
            pct = round((occupied / nmc_beds) * 100, 1) if nmc_beds > 0 else 0
            
            stats_list.append({
                "Department": s_name,
                "NMC_Beds": nmc_beds,
                "Occupied": occupied,
                "PW_Occupied": pw_occ,
                "CW_Occupied": cw_occ,
                "Vacant": vacant,
                "Occupancy_Pct": f"{pct}%",
                "Last_Update": "auto"
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
                         "External_Specialty_Patients", "Total_Occupied", "Occupancy_Percentage",
                         "PW_Occupied", "CW_Occupied"]
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
    cached_users = _get_cached_data("ProcessedUsers", ttl=_USERS_CACHE_TTL)
    if cached_users:
        return cached_users

    print("[AUTH] Refreshing user list from Google Sheets...")
    df_users = _sheet_to_df("Users", timeout=8)


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
    
    _set_cached_data("ProcessedUsers", users)
    print(f"[AUTH] Loaded {len(users)} users (including hardcoded)")
    return users


# ─── API Endpoints ────────────────────────────────────────────────────────────

@app.route('/api/login', methods=['POST'])
def login():
    try:
        # Accept JSON payload or fallback to form-encoded data
        data = request.get_json(silent=True) or request.form
        username = str(data.get('username', '')).strip().lower()
        password = str(data.get('password', '')).strip()
        
        print(f"[AUTH] Login attempt for user: {username}")
        
        users = get_all_users()
        if username in users:
            if users[username]['password'] == password:
                user_info = {k: v for k, v in users[username].items() if k != 'password'}
                print(f"[AUTH] Login success: {username}")
                return jsonify({"success": True, "user": user_info})
            else:
                print(f"[AUTH] Login failed: Wrong password for {username}")
        else:
            print(f"[AUTH] Login failed: User {username} not found")
            
        return jsonify({"success": False, "message": "Invalid username or password"}), 401
    except Exception as e:
        print(f"[AUTH] Login error: {e}")
        return jsonify({"success": False, "message": str(e)}), 500

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
    daycare_dict = {}
    external_total = 0
    own_occ = 0
    own_spec = str(df.at[idx, 'Specialty']).strip().lower()

    pw_total = 0
    cw_total = 0

    for item in specialties:
        spec = str(item.get('specialty', '')).strip()
        unit = str(item.get('unit', '')).strip()

        pw_count = int(item.get('pw_count', 0) or 0)
        cw_count = int(item.get('cw_count', 0) or 0)
        count = int(item.get('count', pw_count + cw_count) or 0)

        if not spec:
            continue

        # if only count is sent, treat as CW by default
        if count > 0 and pw_count == 0 and cw_count == 0:
            cw_count = count

        row_total = max(0, pw_count) + max(0, cw_count)

        # Process daycare
        dc_gf = int(item.get('dc_gf', 0) or 0)
        dc_onc = int(item.get('dc_onc', 0) or 0)
        base_key = f"{spec} {unit}".strip() if unit else spec
        if dc_gf > 0:
            daycare_dict[f"{base_key}|gf"] = daycare_dict.get(f"{base_key}|gf", 0) + dc_gf
        if dc_onc > 0:
            daycare_dict[f"{base_key}|onc"] = daycare_dict.get(f"{base_key}|onc", 0) + dc_onc

        if row_total <= 0:
            continue

        pw_total += max(0, pw_count)
        cw_total += max(0, cw_count)

        if spec.lower() == own_spec:
            own_occ += row_total
        else:
            if pw_count > 0:
                cross_spec_dict[f"{base_key}|private"] = cross_spec_dict.get(f"{base_key}|private", 0) + int(pw_count)
            if cw_count > 0:
                cross_spec_dict[f"{base_key}|common"] = cross_spec_dict.get(f"{base_key}|common", 0) + int(cw_count)
            external_total += row_total

    if 'PW_Occupied' not in df.columns:
        df['PW_Occupied'] = 0
    if 'CW_Occupied' not in df.columns:
        df['CW_Occupied'] = 0
    df.at[idx, 'PW_Occupied'] = int(pw_total)
    df.at[idx, 'CW_Occupied'] = int(cw_total)

    df.at[idx, 'Occupancy'] = own_occ
    df.at[idx, 'External_Specialty_Patients'] = external_total
    df.at[idx, 'Total_Occupied'] = own_occ + external_total
    df.at[idx, 'Cross_Specialty_Name'] = json.dumps(cross_spec_dict) if cross_spec_dict else ""
    if 'Daycare_Details' not in df.columns:
        df['Daycare_Details'] = ""
    df.at[idx, 'Daycare_Details'] = json.dumps(daycare_dict) if daycare_dict else ""
    
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
    _clear_cache("WeeklyDepartmentSummaryPctFile")


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
            "PW_Occupied": int(pw_total),
            "CW_Occupied": int(cw_total),
            "Cross_Specialty_Details": json.dumps(cross_spec_dict) if cross_spec_dict else "",
            "Daycare_Details": json.dumps(daycare_dict) if daycare_dict else ""
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
    _clear_cache("WeeklyDepartmentSummaryPctFile")


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

def _get_dept_history_records(start_date, end_date):
    delta = end_date - start_date
    tabs_to_check = [f"Dept_{(start_date + timedelta(days=i)).strftime('%Y_%m_%d')}" for i in range(delta.days + 1)]
    all_records = []
    
    def fetch_tab(tab):
        try:
            df = _sheet_to_df(tab, custom_url=_DEPT_STATS_SCRIPT_URL)
            if df is not None and not df.empty:
                date_str = tab.replace("Dept_", "").replace("_", "-")
                records = df.to_dict(orient='records')
                for r in records:
                    r["Date"] = date_str
                return records
        except Exception as e:
            print(f"[Dept API] Skipping {tab} due to error: {e}")
        return []

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = executor.map(fetch_tab, tabs_to_check)
        for records in results:
            if records:
                all_records.extend(records)
                
    return all_records

def _get_overall_history_records(start_date, end_date):
    # Check one day before start_date as well due to the 10am shift boundary archiving
    # (Records entered before 10am on start_date are stored in yesterday's tab)
    adj_start = start_date - timedelta(days=1)
    delta = end_date - adj_start
    tabs_to_check = [f"Hist_{(adj_start + timedelta(days=i)).strftime('%Y_%m_%d')}" for i in range(delta.days + 1)]
    
    # Also include the fallbacks just in case data hasn't been archived into tabs yet
    tabs_to_check.extend(["History", "Daily_History"])
    
    all_records = []
    seen_ids = set()
    
    def fetch_tab(tab):
        try:
            df = _sheet_to_df(tab, custom_url=_HISTORY_SCRIPT_URL)
            if df is not None and not df.empty:
                records = df.to_dict(orient='records')
                
                # If it's a specific date tab, we can pre-assign the date for better matching
                if tab.startswith("Hist_"):
                    tab_date = tab.replace("Hist_", "").replace("_", "-")
                    for r in records:
                        if not r.get("Date"):
                            r["Date"] = tab_date
                return records
        except Exception as e:
            print(f"[History API] Skipping {tab} due to error: {e}")
        return []

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = executor.map(fetch_tab, tabs_to_check)
        for records in results:
            for r in records:
                t_val = str(r.get('Timestamp') or '').strip()
                w_val = str(r.get('Ward_Name') or '').strip()
                d_val = str(r.get('Date') or '').strip()
                
                if not w_val:
                    continue
                
                # Composite ID for deduplication: include Date to prevent cross-day collisions when Timestamp is "auto"
                rid = f"{w_val}_{d_val}_{t_val}"

                if rid not in seen_ids:
                    all_records.append(r)
                    seen_ids.add(rid)
                
    return all_records

@app.route('/api/report-summary', methods=['GET'])
def report_summary():
    """Backend filtered report summary for daily/weekly/monthly occupancy with PW/CW averages."""
    try:
        start_str = request.args.get('start_date', '').strip()
        end_str = request.args.get('end_date', '').strip()
        period = request.args.get('period', 'daily').strip().lower()
        department = request.args.get('department', 'all').strip().lower()
        block = request.args.get('block', 'all').strip().lower()
        floor = request.args.get('floor', 'all').strip().lower()
        mode = request.args.get('mode', 'overall').strip().lower()

        if not start_str or not end_str:
            return jsonify({"success": False, "message": "start_date and end_date are required"}), 400

        try:
            start_date = datetime.strptime(start_str, "%Y-%m-%d").date()
            end_date = datetime.strptime(end_str, "%Y-%m-%d").date()
        except ValueError:
            return jsonify({"success": False, "message": "Invalid date format. Use YYYY-MM-DD"}), 400

        if start_date > end_date:
            return jsonify({"success": False, "message": "start_date must be before or equal to end_date"}), 400

        print(f"[REPORT] Mode: {mode}, Range: {start_str} to {end_str}, Dept: {department}, Block: {block}, Floor: {floor}")

        # Ward -> specialty and block map from live bed status
        df_beds = load_data()
        ward_spec_map = {}
        ward_block_map = {}
        ward_floor_map = {}
        if df_beds is not None and not df_beds.empty:
            for _, w in df_beds.iterrows():
                ward_name = str(w.get("Ward_Name", "")).strip()
                spec = str(w.get("Specialty", "")).strip().lower()
                block_val = str(w.get("Block", "Other")).strip()
                floor_val = str(w.get("Floor", "Ground Floor")).strip()
                if ward_name:
                    # Use lower-case keys for robust matching across historical records
                    ward_key = ward_name.lower()
                    ward_spec_map[ward_key] = spec
                    ward_block_map[ward_key] = block_val
                    ward_floor_map[ward_key] = floor_val

        ist = timezone(timedelta(hours=5, minutes=30))
        today_ist = datetime.now(ist).date()
        today_str = today_ist.strftime("%Y-%m-%d")
        
        # Calculate total days in the selected range for correct averaging
        range_total_days = (end_date - start_date).days + 1
        if range_total_days <= 0: range_total_days = 1

        def period_meta(date_str, p):
            dt = datetime.strptime(date_str, "%Y-%m-%d")
            if p == 'daily':
                return {"bucket_key": dt.strftime("%Y-%m-%d"), "label": dt.strftime("%Y-%m-%d"), "period_start": dt.strftime("%Y-%m-%d")}
            if p == 'weekly':
                iso_year, iso_week, _ = dt.isocalendar()
                week_start = datetime.fromisocalendar(iso_year, iso_week, 1)
                return {"bucket_key": f"{iso_year}-W{str(iso_week).zfill(2)}", "label": f"{iso_year}-W{str(iso_week).zfill(2)}", "period_start": week_start.strftime("%Y-%m-%d")}
            month_start = dt.replace(day=1)
            return {"bucket_key": month_start.strftime("%Y-%m"), "label": month_start.strftime("%b %Y"), "period_start": month_start.strftime("%Y-%m-%d")}

        if mode == 'nmc':
            dept_records = _get_dept_history_records(start_date, end_date)
            depts = _get_depts_data()
            # Inject live data if today is requested and not yet archived
            if start_date <= today_ist <= end_date:
                has_today = any(r.get("Date") == today_str for r in dept_records)
                if not has_today:
                    live_wards = load_data()
                    if depts and live_wards is not None:
                        for d in depts:
                            s_name = d.get("name", ""); s_lower = s_name.lower()
                            nmc_val = int(pd.to_numeric(d.get("nmc_beds", 0), errors="coerce") or 0)
                            is_neo = s_lower == 'neonatology'
                            if is_neo:
                                babies = next((ad for ad in depts if ad.get("name", "").lower() == 'babies(cradle bed)'), None)
                                if babies: nmc_val += int(pd.to_numeric(babies.get("nmc_beds", 0), errors="coerce") or 0)
                            if s_lower.startswith('babies') or nmc_val <= 0: continue
                            occ = 0
                            pw_l = 0
                            cw_l = 0
                            for _, w in live_wards.iterrows():
                                w_spec = str(w.get("Specialty", "")).lower()
                                if w_spec == s_lower or (is_neo and w_spec == 'babies(cradle bed)'):
                                    occ += int(pd.to_numeric(w.get("Total_Occupied", 0), errors="coerce") or 0)
                                    pw_l += int(pd.to_numeric(w.get("PW_Occupied", 0), errors="coerce") or 0)
                                    cw_l += int(pd.to_numeric(w.get("CW_Occupied", 0), errors="coerce") or 0)
                                cross_raw = w.get("Cross_Specialty_Details")
                                if cross_raw:
                                    try:
                                        import json
                                        cross = json.loads(cross_raw) if isinstance(cross_raw, str) else cross_raw
                                        for sk, sv in cross.items():
                                            if "|" in sk:
                                                sk_p, tk_p = sk.split("|")
                                                if sk_p.lower().startswith(s_lower):
                                                    occ += sv
                                                    if tk_p == 'private': pw_l += sv
                                                    else: cw_l += sv
                                            else:
                                                if sk.lower().startswith(s_lower):
                                                    occ += sv
                                                    cw_l += sv
                                    except: pass
                            dept_records.append({
                                "Department": s_name,
                                "Date": today_str,
                                "Occupied": occ,
                                "PW_Occupied": pw_l,
                                "CW_Occupied": cw_l
                            })

            period_dept_map = {}
            for r in dept_records:
                dept_name = r.get("Department")
                if not dept_name or (department != 'all' and department.lower() != dept_name.lower()): continue
                
                # We group everything into a single 'Range Summary' bucket per department
                key = ("summary", dept_name)
                if key not in period_dept_map:
                    period_dept_map[key] = {
                        "department": dept_name, 
                        "period_label": f"{start_str} to {end_str}", 
                        "period_start": start_str, 
                        "occ": 0, "pw": 0, "cw": 0, "dates": 0
                    }
                
                occ_val = int(pd.to_numeric(r.get("Occupied", 0), errors="coerce") or 0)
                period_dept_map[key]["occ"] += occ_val
                period_dept_map[key]["pw"] += int(pd.to_numeric(r.get("PW_Occupied", 0), errors="coerce") or 0)
                period_dept_map[key]["cw"] += int(pd.to_numeric(r.get("CW_Occupied", 0), errors="coerce") or 0)
                period_dept_map[key]["dates"] += 1
            
            result_rows = []
            for _, bucket in sorted(period_dept_map.items(), key=lambda item: item[1]["department"]):
                # Always divide by the total window size
                denom = max(1, range_total_days)
                avg_occ = bucket["occ"] / denom
                
                dept_name = bucket["department"]
                d_lower = dept_name.strip().lower()
                dept_info = next((d for d in (depts or []) if str(d.get("name", "")).strip().lower() == d_lower), {})
                nmc_cap = int(pd.to_numeric(dept_info.get("nmc_beds", 0), errors="coerce") or 0)
                
                result_rows.append({
                    "department": dept_name,
                    "period": bucket["period_label"],
                    "avgOcc": round(avg_occ),
                    "capacity": nmc_cap,
                    "pct": (avg_occ / nmc_cap * 100) if nmc_cap > 0 else 0,
                    "avgPW": round(bucket["pw"] / denom),
                    "avgCW": round(bucket["cw"] / denom),
                    "days": bucket["dates"]
                })
            
            # Filter out non-NMC departments (capacity = 0) to keep the report focused
            result_rows = [r for r in result_rows if r.get("capacity", 0) > 0]

            return jsonify({"success": True, "rows": result_rows})
        else:
            history_records = _get_overall_history_records(start_date, end_date)
            print(f"[REPORT] Fetched {len(history_records)} historical records")
            filtered = []
            for r in history_records:
                d_val = r.get("Date") or r.get("Timestamp")
                if not d_val: continue
                try: 
                    d_dt = pd.to_datetime(d_val)
                    # If it has timezone info (like ISO strings from Sheets), convert to IST
                    if d_dt.tzinfo is not None:
                        d_dt = d_dt.tz_convert(ist)
                    elif isinstance(d_val, str) and 'T' in d_val:
                        # Assume ISO UTC if 'T' is present but no TZ info
                        d_dt = d_dt.replace(tzinfo=timezone.utc).astimezone(ist)
                    d_obj = d_dt.date()
                except: continue
                if d_obj < start_date or d_obj > end_date: continue
                r["_parsed_date"] = d_obj.strftime("%Y-%m-%d")
                filtered.append(r)
            
            print(f"[REPORT] Filtered to {len(filtered)} records for range. Injection check for: {today_str}")
            # Inject live data if today is requested and no archived records exist for today
            if start_date <= today_ist <= end_date:
                has_today = any(r.get("_parsed_date") == today_str for r in filtered)
                print(f"[REPORT] has_today? {has_today}")
                if not has_today:
                    if df_beds is not None and not df_beds.empty:
                        print(f"[REPORT] Injecting {len(df_beds)} live wards")
                        for _, w in df_beds.iterrows():
                            filtered.append({
                                "Ward_Name": w.get("Ward_Name"),
                                "Total_Sanctioned": w.get("sanctioned_beds"),
                                "Total_Occupied": w.get("Total_Occupied"),
                                "PW_Occupied": w.get("PW_Occupied"),
                                "CW_Occupied": w.get("CW_Occupied"),
                                "Vacant": w.get("Vacant_Beds"),
                                "_parsed_date": today_str,
                                "Timestamp": datetime.now(ist).strftime("%Y-%m-%d %H:%M:%S")
                            })

            if department != 'all':
                filtered = [r for r in filtered if ward_spec_map.get(str(r.get("Ward_Name", "")).strip().lower(), "") == department]
            if block != 'all':
                filtered = [r for r in filtered if ward_block_map.get(str(r.get("Ward_Name", "")).strip().lower(), "").lower() == block]
            if floor != 'all':
                filtered = [r for r in filtered if ward_floor_map.get(str(r.get("Ward_Name", "")).strip().lower(), "").lower() == floor]

            print(f"[REPORT] Final filtered count: {len(filtered)}")
            # Deduplicate by ward and date (keep latest timestamp for each day)
            ward_date_map = {}
            daily_summary = {} # Trend data (hospital-wide per day)
            
            for r in filtered:
                w = str(r.get("Ward_Name", "")).strip(); d = r.get("_parsed_date")
                if not w or not d: continue
                key = (w, d)
                if key not in ward_date_map or str(r.get("Timestamp", "")) >= str(ward_date_map[key].get("Timestamp", "")):
                    ward_date_map[key] = r

            # Aggregate per ward over the whole range (to match NMC logic)
            ward_agg = {}
            for (w, d), r in ward_date_map.items():
                if w not in ward_agg:
                    ward_agg[w] = {
                        "ward": w,
                        "block": ward_block_map.get(w.lower(), "Other"),
                        "floor": ward_floor_map.get(w.lower(), "Other"),
                        "occ": 0, "pw": 0, "cw": 0, "cap": 0, "vacant": 0, "dates": 0
                    }
                s = ward_agg[w]
                occ_v = int(pd.to_numeric(r.get("Total_Occupied", 0), errors="coerce") or 0)
                s["occ"] += occ_v
                s["cap"] += int(pd.to_numeric(r.get("Total_Sanctioned", 0), errors="coerce") or 0)
                
                # PW/CW fallbacks for older records
                pw_v = r.get("PW_Occupied")
                if pw_v is None: pw_v = r.get("Own_Occupied")
                pw_v = int(pd.to_numeric(pw_v, errors="coerce") or 0)
                s["pw"] += pw_v
                
                cw_v = r.get("CW_Occupied")
                if cw_v is None: cw_v = occ_v - pw_v
                s["cw"] += int(pd.to_numeric(cw_v, errors="coerce") or 0)
                
                s["vacant"] += int(pd.to_numeric(r.get("Vacant", 0), errors="coerce") or 0)
                s["dates"] += 1
                
                # Also track daily hospital-wide stats for the trend chart
                if d not in daily_summary: daily_summary[d] = {"occ": 0, "pw": 0, "cw": 0}
                daily_summary[d]["occ"] += occ_v
                daily_summary[d]["pw"] += pw_v
                daily_summary[d]["cw"] += cw_v

            rows = []
            # Use range_total_days as denominator to match NMC aggregation logic
            denom = max(1, range_total_days)
            for w, s in sorted(ward_agg.items()):
                avg_occ = s["occ"] / denom
                avg_cap = s["cap"] / denom
                rows.append({
                    "ward": s["ward"], 
                    "block": s["block"], 
                    "floor": s["floor"],
                    "capacity": round(avg_cap), 
                    "occ": round(avg_occ), 
                    "pw": round(s["pw"] / denom), 
                    "cw": round(s["cw"] / denom), 
                    "vacant": round(s["vacant"] / denom), 
                    "pct": round((avg_occ/avg_cap)*100, 2) if avg_cap > 0 else 0
                })

            # Calculate period-based trend (Daily/Weekly/Monthly) for the chart
            period_map = {}
            for d, vals in daily_summary.items():
                meta = period_meta(d, period); pkey = meta["bucket_key"]
                if pkey not in period_map: 
                    period_map[pkey] = {"label": meta["label"], "period_start": meta["period_start"], "occ": 0, "pw": 0, "cw": 0, "dates": 0}
                period_map[pkey]["dates"] += 1
                period_map[pkey]["occ"] += vals["occ"]
                period_map[pkey]["pw"] += vals["pw"]
                period_map[pkey]["cw"] += vals["cw"]

            summary_rows = []
            for _, b in sorted(period_map.items(), key=lambda item: item[1]["period_start"]):
                d_count = b["dates"] or 1
                summary_rows.append({
                    "period": b["label"], 
                    "avgOcc": int(round(b["occ"] / d_count)), 
                    "avgPW": int(round(b["pw"] / d_count)), 
                    "avgCW": int(round(b["cw"] / d_count))
                })
            
            return jsonify({"success": True, "rows": rows, "summary": summary_rows})
    except Exception as e:
        print(f"[ReportSummary] Error: {e}")
        return jsonify({"success": False, "message": "Failed to build report summary"}), 500


@app.route('/api/weekly-department-summary', methods=['GET'])
def weekly_department_summary():
    """Download weekly average occupancy percentage (%) for each NMC department."""
    try:
        cache_key = "WeeklyDepartmentSummaryPctFile"
        cached_file = _get_cached_data(cache_key, ttl=_WEEKLY_SUMMARY_TTL)
        if cached_file is not None:
            return send_file(
                io.BytesIO(cached_file),
                as_attachment=True,
                download_name=f"weekly_department_summary_{datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime('%Y_%m_%d')}.xlsx",
                mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            )

        depts = _get_depts_data()
        if not depts:
            return jsonify({"success": False, "message": "No departments found"}), 404

        # NMC department capacities
        dept_caps = {}
        for d in depts:
            name = str(d.get("name", "")).strip()
            nmc_beds = int(pd.to_numeric(d.get("nmc_beds", 0), errors="coerce") or 0)
            if not name or nmc_beds <= 0:
                continue
            key = name.lower()
            if key not in dept_caps or nmc_beds > dept_caps[key]["nmc_beds"]:
                dept_caps[key] = {"name": name, "nmc_beds": nmc_beds}

        if not dept_caps:
            return jsonify({"success": False, "message": "No NMC listed departments found"}), 404

        ist = timezone(timedelta(hours=5, minutes=30))
        now_ist = datetime.now(ist)
        days = [now_ist - timedelta(days=i) for i in range(7)]
        day_labels = [d.strftime("%Y-%m-%d") for d in days]
        tabs = [f"Hist_{d.strftime('%Y_%m_%d')}" for d in days]
        day_set = set(day_labels)

        # Ward -> own specialty map
        df_beds = load_data()
        ward_to_spec = {}
        if df_beds is not None and not df_beds.empty:
            for _, w in df_beds.iterrows():
                wname = str(w.get("Ward_Name", "")).strip()
                spec = str(w.get("Specialty", "")).strip().lower()
                if wname and spec:
                    ward_to_spec[wname] = spec

        import json
        occ = {k: {d: 0 for d in day_labels} for k in dept_caps.keys()}

        for tab in tabs:
            df_tab = _sheet_to_df(tab, custom_url=_HISTORY_SCRIPT_URL)
            if df_tab is None or df_tab.empty:
                continue

            for _, r in df_tab.iterrows():
                r_date = str(r.get("Date", "")).strip()
                if r_date not in day_set:
                    continue

                ward_name = str(r.get("Ward_Name", "")).strip()
                own_occ = int(pd.to_numeric(r.get("Own_Occupied", 0), errors="coerce") or 0)
                w_spec = ward_to_spec.get(ward_name, "")
                if w_spec in occ and own_occ > 0:
                    occ[w_spec][r_date] += own_occ

                cross_raw = r.get("Cross_Specialty_Details", "")
                if cross_raw and isinstance(cross_raw, str):
                    try:
                        cross_map = json.loads(cross_raw)
                        for k, v in cross_map.items():
                            cnt = int(pd.to_numeric(v, errors="coerce") or 0)
                            if cnt <= 0:
                                continue
                            base = str(k).split("|")[0].strip().lower()
                            for dk in occ.keys():
                                if base.startswith(dk):
                                    occ[dk][r_date] += cnt
                    except Exception:
                        pass

        rows = []
        for dk in sorted(dept_caps.keys()):
            name = dept_caps[dk]["name"]
            cap = int(dept_caps[dk]["nmc_beds"])
            if cap <= 0:
                continue

            daily_pct = []
            for d in day_labels:
                pct = (occ[dk][d] / cap) * 100
                daily_pct.append(pct)

            avg_pct = round(float(np.mean(daily_pct)) if daily_pct else 0.0, 2)
            rows.append({
                "Department": name,
                "Avg_Occupancy_Pct_Last_7_Days": avg_pct
            })

        df_out = pd.DataFrame(rows)

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine="openpyxl") as writer:
            df_out.to_excel(writer, index=False, sheet_name="Weekly Summary")
        file_bytes = output.getvalue()
        _set_cached_data(cache_key, file_bytes)

        return send_file(
            io.BytesIO(file_bytes),
            as_attachment=True,
            download_name=f"weekly_department_summary_{now_ist.strftime('%Y_%m_%d')}.xlsx",
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
    except Exception as e:
        print(f"[WeeklySummary] Error: {e}")
        return jsonify({"success": False, "message": "Failed to generate weekly summary"}), 500

def generate_unique_code(length=4):
    return ''.join(random.choices(string.digits, k=length))

@app.route('/api/pastor/ticket/create', methods=['POST'])
def create_pastor_ticket():
    import json
    data = request.get_json()
    ward_name = data.get('Ward_Name')
    service_type = data.get('Service_Type')
    nurse_id = data.get('Nurse_ID')
    patient_name = data.get('Patient_Name')
    additional_info = data.get('Additional_Info', '')
    
    if not ward_name or not service_type or not nurse_id or not patient_name:
        return jsonify({"success": False, "message": "Ward_Name, Service_Type, Nurse_ID, and Patient_Name are required"}), 400
        
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_ids_str = os.environ.get("TELEGRAM_CHAT_IDS", "")
    chat_ids = [cid.strip() for cid in chat_ids_str.split(',') if cid.strip()]
    
    # Generate unique codes for each pastor chat ID
    # Fallback to a single code if no chat IDs are configured
    codes_map = {}
    if chat_ids:
        for cid in chat_ids:
            codes_map[cid] = generate_unique_code(4)
        unique_code_val = json.dumps(codes_map)
    else:
        fallback_code = generate_unique_code(4)
        unique_code_val = fallback_code
        
    ist = timezone(timedelta(hours=5, minutes=30))
    now_ist = datetime.now(ist).strftime("%Y-%m-%d %H:%M:%S")
    
    ticket = {
        "Ticket_ID": f"TKT-{generate_unique_code(6)}",
        "Ward_Name": ward_name,
        "Service_Type": service_type,
        "Nurse_ID": nurse_id,
        "Patient_Name": patient_name,
        "Additional_Info": additional_info,
        "Status": "Open",
        "Unique_Code": unique_code_val,
        "Timestamp_Opened": now_ist,
        "Timestamp_Closed": "",
        "Closed_By": ""
    }
    
    df_ticket = pd.DataFrame([ticket])
    success = _df_to_sheet(df_ticket, "Pastor_Tickets", action="append", custom_url=_PASTOR_SCRIPT_URL)
    if success:
        # ---- TELEGRAM LOGIC START ----
        telegram_sent = False
        try:
            # 1. Fetch Block and Floor from BedStatus
            df_beds = load_data()
            block = "Unknown Block"
            floor = "Unknown Floor"
            if df_beds is not None and not df_beds.empty:
                ward_row = df_beds[df_beds['Ward_Name'].astype(str).str.lower() == str(ward_name).lower()]
                if not ward_row.empty:
                    block = str(ward_row.iloc[0].get('Block', 'Unknown Block'))
                    floor = str(ward_row.iloc[0].get('Floor', 'Unknown Floor'))

            # 2. Send customized message to Telegram Chat IDs
            api_base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip('/')
            
            if bot_token and chat_ids and bot_token != "your_bot_token_here":
                for chat_id in chat_ids:
                    pastor_code = codes_map[chat_id]
                    info_section = f"📝 *Add Info (room/bed number):* {additional_info}\n" if additional_info else ""
                    telegram_msg = (
                        f"🙏 *Pastoral Service Request*\n\n"
                        f"📍 *Ward:* {ward_name}\n"
                        f"🏢 *Block:* {block}\n"
                        f"🪜 *Floor:* {floor}\n"
                        f"🛏️ *Patient:* {patient_name}\n"
                        f"🩺 *Nurse ID:* {nurse_id}\n"
                        f"✨ *Service:* {service_type}\n"
                        f"{info_section}\n"
                        f"🔒 *Closure Code:* `{pastor_code}`"
                    )
                    url = f"{api_base}/bot{bot_token}/sendMessage"
                    payload = {
                        "chat_id": chat_id,
                        "text": telegram_msg,
                        "parse_mode": "Markdown"
                    }
                    try:
                        resp = requests.post(url, json=payload, timeout=5)
                        if resp.status_code == 200:
                            telegram_sent = True
                    except Exception as e_req:
                        print(f"[Telegram] Failed to send message to {chat_id}: {e_req}")
        except Exception as e:
            print(f"[Telegram] Error in telegram logic: {e}")
        # ---- TELEGRAM LOGIC END ----

        return jsonify({"success": True, "ticket": ticket, "telegram_sent": telegram_sent})
    else:
        # If it fails, fallback to success for now so frontend works, but log error
        print("[Pastor API] Failed to save ticket to Google Sheets")
        return jsonify({"success": True, "ticket": ticket, "warning": "Failed to sync to Sheets", "telegram_sent": False})

@app.route('/api/pastor/tickets', methods=['GET'])
def get_pastor_tickets():
    ward_name = request.args.get('ward')
    df = _sheet_to_df("Pastor_Tickets", force_refresh=True, custom_url=_PASTOR_SCRIPT_URL)
    
    if df is None or df.empty:
        return jsonify([])
        
    if ward_name:
        df = df[df['Ward_Name'].astype(str).str.lower() == ward_name.lower()]
        
    if df.empty or 'Status' not in df.columns:
        return jsonify([])
        
    open_tickets = df[df['Status'].astype(str).str.lower() == 'open']
    
    records = open_tickets.to_dict(orient='records')
    # Strip sensitive data if needed, but we need Unique_Code on backend to verify.
    # Actually, the nurse needs to enter the Unique_Code. The frontend shouldn't have it unless it's just for display. 
    # We will remove Unique_Code here so it can't be spoofed easily, wait, if the nurse has to enter it, we shouldn't send it.
    for r in records:
        if 'Unique_Code' in r:
            del r['Unique_Code']
            
    return jsonify(records)

@app.route('/api/pastor/ticket/close', methods=['POST'])
def close_pastor_ticket():
    import json
    data = request.get_json()
    ticket_id = data.get('Ticket_ID')
    code = data.get('Unique_Code')
    
    if not ticket_id or not code:
        return jsonify({"success": False, "message": "Ticket_ID and Unique_Code are required"}), 400
        
    df = _sheet_to_df("Pastor_Tickets", force_refresh=True, custom_url=_PASTOR_SCRIPT_URL)
    if df is None or df.empty:
        return jsonify({"success": False, "message": "No tickets found"}), 404
        
    ticket_idx = df[df['Ticket_ID'] == ticket_id].index
    if len(ticket_idx) == 0:
        return jsonify({"success": False, "message": "Ticket not found"}), 404
        
    idx = ticket_idx[0]
    actual_code = str(df.at[idx, 'Unique_Code']).strip()
    
    # Try parsing actual_code as JSON
    matched_pastor = None
    try:
        codes_map = json.loads(actual_code)
        if isinstance(codes_map, dict):
            for cid, val in codes_map.items():
                if str(val).strip() == str(code).strip():
                    matched_pastor = cid
                    break
        else:
            if str(actual_code) == str(code).strip():
                matched_pastor = "Legacy Match"
    except Exception:
        # Fallback for old tickets with plain string code
        if str(actual_code) == str(code).strip():
            matched_pastor = "Legacy Match"
            
    if matched_pastor is None:
        return jsonify({"success": False, "message": "Invalid code"}), 401
        
    if str(df.at[idx, 'Status']).strip().lower() != 'open':
        return jsonify({"success": False, "message": "Ticket is already closed"}), 400
        
    ist = timezone(timedelta(hours=5, minutes=30))
    now_ist = datetime.now(ist).strftime("%Y-%m-%d %H:%M:%S")
    
    df.at[idx, 'Status'] = 'Closed'
    df.at[idx, 'Timestamp_Closed'] = now_ist
    df.at[idx, 'Closed_By'] = matched_pastor
    
    # Ensure all columns exist in df
    if 'Closed_By' not in df.columns:
        df['Closed_By'] = ""
    if 'Additional_Info' not in df.columns:
        df['Additional_Info'] = ""
        
    success = _df_to_sheet(df, "Pastor_Tickets", action="overwrite", custom_url=_PASTOR_SCRIPT_URL)
    
    if success:
        return jsonify({"success": True})
    else:
        return jsonify({"success": False, "message": "Failed to update ticket"}), 500

@app.route('/api/pastor/contacts', methods=['GET'])
def get_pastor_contacts():
    df = _sheet_to_df("Pastor_Contacts", force_refresh=True, custom_url=_PASTOR_SCRIPT_URL)
    if df is None or df.empty:
        return jsonify([])
    return jsonify(df.to_dict(orient='records'))

if __name__ == '__main__':
    app.run(debug=True, port=5000)
