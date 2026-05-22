const API_BASE = '/api';

// Safe localStorage parsing
let currentUser = null;
try {
    const storedUser = localStorage.getItem('user');
    if (storedUser && storedUser !== 'undefined') {
        currentUser = JSON.parse(storedUser);
    }
} catch (e) {
    console.error("[AUTH] Error parsing user from localStorage:", e);
    localStorage.removeItem('user');
}

window.onerror = function (msg, url, line, col, error) {
    console.error("[GLOBAL ERROR]", msg, "at", url, ":", line);
    // Optional: alert("[CRASH] " + msg); 
    return false;
};

let currentMode = 'overall'; // 'overall' or 'nmc'
let charts = {};
let allWardsData = [];
let allDepartments = [];
let refreshInterval = null;
let wardChoiceInstance = null;

let reportDebounceTimer = null;
let reportRequestInFlight = false;
let reportViewActive = false;
let reportDeptOptionsSignature = '';
let lastReportData = [];

let deptColorMap = {};
const parseCrossSpecKey = (rawKey) => {
    const full = String(rawKey || '');
    const [base, bedTypeRaw] = full.split('|');
    return {
        baseSpecUnit: (base || '').trim(),
        bedType: (bedTypeRaw || '').trim().toLowerCase()
    };
};
const globalPalette = [
    '#4285F4', '#34A853', '#EA4335', '#FBBC05', '#24C1E0', '#A142F4',
    '#FF6D01', '#607D8B', '#009688', '#795548', '#9C27B0', '#E91E63',
    '#00BCD4', '#CDDC39', '#FFEB3B', '#FF9800', '#795548', '#607D8B'
];

function getDeptColor(name) {
    const cleaner = (s) => s.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    const cleanName = cleaner(name);

    if (cleanName === 'Others' || cleanName === 'Empty') return '#E8EAED';
    if (deptColorMap[cleanName]) return deptColorMap[cleanName];

    // Assign next available color
    const mappedCount = Object.keys(deptColorMap).length;
    const color = globalPalette[mappedCount % globalPalette.length];
    deptColorMap[cleanName] = color;
    return color;
}

function init() {
    console.log("[INIT] Initializing application...");
    initAuth();
    initTabs();
    initForms();
    if (currentUser) {
        startAutoRefresh();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);

    // Initial load
    refreshData();

    // Set interval for every 10 seconds
    refreshInterval = setInterval(refreshData, 10000);
}

function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

function refreshData() {
    if (!currentUser) {
        stopAutoRefresh();
        return;
    }

    if (currentUser.role === 'admin' || currentUser.role === 'nmc') {
        const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab');
        if (activeTab === 'dashboard') {
            loadDashboardData();
        }
        // Removed loadReportData() from auto-refresh to prevent resetting filtered reports every 10s
    } else {
        loadNurseData();
    }

    // Auto-refresh pastor tickets if the tab is active and a ward is selected
    const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab');
    if (activeTab === 'pastor_services') {
        const pastorWard = document.getElementById('pastor-ward-select')?.value;
        if (pastorWard) {
            refreshPastorServices(pastorWard, false);
        }
    }
}

function initAuth() {
    console.log("[AUTH] initAuth called, currentUser:", currentUser);
    const loginSection = document.getElementById('login-section');
    const mainSection = document.getElementById('main-section');
    const userInfoBar = document.getElementById('user-info-bar');
    const welcomeMsg = document.getElementById('welcome-message');

    // ── Attach login form handler (runs once; guarded by flag) ──
    const loginForm = document.getElementById('login-form');
    console.log("[AUTH] loginForm element:", loginForm);
    if (loginForm && !loginForm.dataset.listenerAttached) {
        console.log("[AUTH] Attaching listener to login-form");
        loginForm.dataset.listenerAttached = 'true';
        loginForm.addEventListener('submit', async (e) => {
            console.log("[AUTH] Form submit triggered");
            e.preventDefault();
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            const errorMsg = document.getElementById('login-error');
            const submitBtn = loginForm.querySelector('button[type="submit"]');

            if (errorMsg) errorMsg.textContent = '';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing in…'; }

            try {
                const response = await axios.post(`${API_BASE}/login`, { username, password });
                if (response.data.success) {
                    currentUser = response.data.user;
                    localStorage.setItem('user', JSON.stringify(currentUser));
                    initAuth();
                    startAutoRefresh();
                } else {
                    if (errorMsg) errorMsg.textContent = response.data.message || 'Invalid credentials.';
                }
            } catch (error) {
                if (errorMsg) errorMsg.textContent = error.response?.data?.message || 'Login failed. Please try again.';
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign In'; }
            }
        });
    }

    if (currentUser) {
        loginSection.style.display = 'none';
        mainSection.style.display = 'block';
        userInfoBar.style.display = 'flex';
        welcomeMsg.textContent = `Welcome, ${currentUser.name}`;

        if (currentUser.role === 'admin' || currentUser.role === 'nmc') {
            if (currentUser.role === 'nmc') {
                currentMode = 'nmc';
                const subtitle = document.getElementById('header-subtitle');
                if (subtitle) subtitle.textContent = 'Bed Occupancy & Hospital Statistics (NMC View)';
            }
            // document.getElementById('transfer-section').style.display = 'block';
            initModeToggle();
        } else {
            // Switch to Bed Entry if on restricted tab or just logged in
            const dashboardBtn = document.getElementById('dashboard-btn');
            const dashboardTab = document.getElementById('dashboard-tab');
            const reportBtn = document.getElementById('report-tab');
            const reportTabPane = document.getElementById('ward-report-tab');

            if (dashboardBtn) dashboardBtn.style.display = 'none';
            if (reportBtn) reportBtn.style.display = 'none';

            // Ensure they are on Bed Entry
            const bedEntryBtn = document.getElementById('bed-entry-btn');
            const bedEntryTab = document.getElementById('bed-entry-tab');

            if (bedEntryBtn && bedEntryTab) {
                // Remove active from others
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

                // Set bed entry active
                bedEntryBtn.classList.add('active');
                bedEntryTab.classList.add('active');
            }
        }
    } else {
        loginSection.style.display = 'block';
        mainSection.style.display = 'none';
        userInfoBar.style.display = 'none';
    }
}

function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            const paneId = `${tabId.replace(/_/g, '-')}-tab`;

            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            tabPanes.forEach(p => p.classList.remove('active'));
            const activePane = document.getElementById(paneId);
            if (activePane) {
                activePane.classList.add('active');
            }

            if (tabId === 'dashboard') {
                if (currentUser?.role === 'admin') loadDashboardData();
                else console.warn("Access denied to dashboard");
            }
            if (tabId === 'ward_report') {
                if (currentUser?.role === 'admin' || currentUser?.role === 'nmc') loadReportData();
                else console.warn("Access denied to report");
            }
            if (tabId === 'bed_entry') {
                clearBedEntryForm();
            }
        });
    });
}

function clearBedEntryForm() {
    const wardSelect = document.getElementById('ward-select');
    if (typeof wardChoiceInstance !== 'undefined' && wardChoiceInstance) {
        wardChoiceInstance.setChoiceByValue('');
    } else if (wardSelect) {
        wardSelect.value = '';
    }

    const blockInput = document.getElementById('entry-block');
    const floorInput = document.getElementById('entry-floor');
    const sancInput = document.getElementById('sanctioned-beds');
    const dateInput = document.getElementById('entry-date');
    const empInput = document.getElementById('emp-id');
    const notesInput = document.getElementById('entry-notes');
    const commonWardBedCountInput = document.getElementById('common-ward-bed-count');
    const rowContainer = document.getElementById('specialty-rows-container');

    if (blockInput) blockInput.value = '';
    if (floorInput) floorInput.value = '';
    if (sancInput) sancInput.value = '';
    if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
    if (empInput) empInput.value = '';
    if (notesInput) notesInput.value = '';
    if (commonWardBedCountInput) commonWardBedCountInput.value = '0';
    if (rowContainer) rowContainer.innerHTML = '';

    // Reset calculated displays
    const totalOccEl = document.getElementById('total-occupied-display');
    const vacantEl = document.getElementById('vacant-beds-display');
    if (totalOccEl) totalOccEl.value = '0';
    if (vacantEl) vacantEl.value = '0';
}

// ─── Modal Functions ─────────────────────────────────────────────────────────

function openWardModal(ward) {
    const modal = document.getElementById('ward-modal');
    if (!modal) return;

    // Populate static fields
    document.getElementById('modal-ward-name').textContent = ward.Ward_Name || 'Unknown Ward';
    document.getElementById('modal-ward-location').textContent = `${ward.Block || 'Other'} Block - ${ward.Floor || 'Ground Floor'}`;
    document.getElementById('modal-total-beds').textContent = ward.sanctioned_beds || 0;
    document.getElementById('modal-occupied-beds').textContent = ward.Total_Occupied || 0;
    document.getElementById('modal-vacant-beds').textContent = ward.Vacant_Beds || 0;

    // Determine Submitter
    let submitter = ward.EMPID || 'Unknown';

    // Fallback: If unknown, search for the latest EMPID in history for this specific ward
    if ((!submitter || submitter === 'Unknown') && fullHistoryData && fullHistoryData.length > 0) {
        // Sort history by timestamp descending and find the first matching record with an EMPID
        const wardHistory = fullHistoryData
            .filter(r => r.Ward_Name === ward.Ward_Name && r.EMPID && r.EMPID !== 'Unknown')
            .sort((a, b) => new Date(b.Timestamp.replace(' ', 'T')) - new Date(a.Timestamp.replace(' ', 'T')));

        if (wardHistory.length > 0) {
            submitter = wardHistory[0].EMPID;
        }
    }

    document.getElementById('modal-incharge').textContent = submitter;

    document.getElementById('modal-last-updated').textContent = new Date().toLocaleDateString();

    // Populate Specialty List
    const specList = document.getElementById('modal-specialty-list');
    specList.innerHTML = ''; // clear

    const addSpecItem = (name, count) => {
        if (!name || count <= 0) return;
        const li = document.createElement('li');
        li.className = 'specialty-item';
        li.innerHTML = `
            <span class="specialty-name">${name}</span>
            <span class="specialty-count">${count} Patients</span>
        `;
        specList.appendChild(li);
    };

    // Main specialty
    if (ward.Specialty && ward.Occupancy > 0) {
        addSpecItem(ward.Specialty, ward.Occupancy);
    }

    // Cross specialties
    if (ward.Cross_Specialty_Name) {
        try {
            const cross = JSON.parse(ward.Cross_Specialty_Name);
            for (let [spec, count] of Object.entries(cross)) {
                addSpecItem(spec, parseInt(count) || 0);
            }
        } catch (e) {
            console.error("Error parsing cross specialty for modal:", e);
        }
    }

    // Daycare details
    if (ward.Daycare_Details) {
        try {
            const dc = JSON.parse(ward.Daycare_Details);
            for (let [specKey, count] of Object.entries(dc)) {
                const val = parseInt(count) || 0;
                if (val > 0) {
                    const label = specKey.includes('|gf') ? 'Daycare GF' : 'Daycare Onc';
                    const cleanSpec = specKey.split('|')[0];
                    const li = document.createElement('li');
                    li.className = 'specialty-item';
                    li.style.borderLeft = '3px solid var(--secondary-color)';
                    li.innerHTML = `
                        <span class="specialty-name">${cleanSpec} <small class="babies-label">(${label})</small></span>
                        <span class="specialty-count">${val} Patients</span>
                    `;
                    specList.appendChild(li);
                }
            }
        } catch (e) {
            console.error("Error parsing daycare for modal:", e);
        }
    }

    if (specList.children.length === 0) {
        specList.innerHTML = '<li class="specialty-item"><span class="secondary-color">No patients currently admitted.</span></li>';
    }

    modal.style.display = 'flex';
}

function closeWardModal() {
    const modal = document.getElementById('ward-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function openDeptModal(deptName, breakdown, nmcBeds, totalPatients, daycareGF = 0, daycareOnc = 0) {
    const modal = document.getElementById('dept-modal');
    if (!modal) return;

    document.getElementById('modal-dept-name').textContent = deptName;
    document.getElementById('modal-dept-nmc-beds').textContent = nmcBeds;
    document.getElementById('modal-dept-patients').textContent = totalPatients;
    document.getElementById('modal-dept-vacant').textContent = Math.max(0, nmcBeds - totalPatients);

    const breakdownList = document.getElementById('modal-dept-breakdown-list');
    breakdownList.innerHTML = '';

    breakdown.forEach(item => {
        const li = document.createElement('li');
        li.className = 'specialty-item';
        li.innerHTML = `
            <span class="specialty-name">${item.name}</span>
            <span class="specialty-count">${item.count} Patients</span>
        `;
        breakdownList.appendChild(li);
    });

    if (breakdown.length === 0) {
        breakdownList.innerHTML = '<li class="specialty-item"><span class="secondary-color">No patients currently admitted.</span></li>';
    }

    // Dynamic Daycare Statistics section in the modal
    let daycareSection = document.getElementById('modal-dept-daycare-section');
    if (!daycareSection) {
        const modalBody = modal.querySelector('.modal-body');
        if (modalBody) {
            daycareSection = document.createElement('div');
            daycareSection.id = 'modal-dept-daycare-section';
            daycareSection.className = 'modal-section mt-2';
            modalBody.appendChild(daycareSection);
        }
    }

    if (daycareSection) {
        if (daycareGF > 0 || daycareOnc > 0) {
            daycareSection.innerHTML = `
                <h4 class="section-title">Daycare Statistics</h4>
                <ul class="specialty-list">
                    ${daycareGF > 0 ? `
                    <li class="specialty-item" style="border-left: 3px solid var(--secondary-color);">
                        <span class="specialty-name">Daycare Ground Floor</span>
                        <span class="specialty-count">${daycareGF} Patients</span>
                    </li>` : ''}
                    ${daycareOnc > 0 ? `
                    <li class="specialty-item" style="border-left: 3px solid var(--secondary-color);">
                        <span class="specialty-name">Daycare Oncology</span>
                        <span class="specialty-count">${daycareOnc} Patients</span>
                    </li>` : ''}
                </ul>
            `;
            daycareSection.style.display = 'block';
        } else {
            daycareSection.style.display = 'none';
        }
    }

    modal.style.display = 'flex';
}

function closeDeptModal() {
    const modal = document.getElementById('dept-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// ─── Authentication ──────────────────────────────────────────────────────────
// Login form listener is now wired inside initAuth() to guarantee DOM readiness.

function initModeToggle() {
    const selector = document.getElementById('admin-mode-selector');
    if (!selector) return;

    if (currentUser?.role === 'admin' || currentUser?.role === 'nmc') {
        selector.style.display = 'flex';

        // Hide 'Overall' mode button for NMC role
        const overallBtn = selector.querySelector('[data-mode="overall"]');
        if (overallBtn) {
            overallBtn.style.display = (currentUser.role === 'nmc') ? 'none' : 'block';
        }

        // Set 'NMC' button as active for NMC role initially
        if (currentUser.role === 'nmc') {
            const nmcBtn = selector.querySelector('[data-mode="nmc"]');
            if (nmcBtn) {
                selector.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                nmcBtn.classList.add('active');
            }
        }
    } else {
        selector.style.display = 'none';
    }

    const btns = selector.querySelectorAll('.mode-btn');
    btns.forEach(btn => {
        btn.onclick = () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentMode = btn.dataset.mode || btn.getAttribute('data-mode');
            console.log("MODE SWITCH CLICKED:", currentMode);

            // Clear filters when switching modes to ensure a fresh state
            const blockSelect = document.getElementById('filter-block');
            const floorSelect = document.getElementById('filter-floor');
            const deptSelect = document.getElementById('filter-dept');
            const wardSelect = document.getElementById('filter-ward');
            const unitSelect = document.getElementById('filter-unit');

            if (blockSelect) blockSelect.value = 'all';
            if (floorSelect) floorSelect.value = 'all';
            if (deptSelect) deptSelect.value = 'all';
            if (wardSelect) wardSelect.value = 'all';
            if (unitSelect) {
                unitSelect.innerHTML = '<option value="all">All Units</option>';
                unitSelect.disabled = true;
            }

            // Update UI/Data based on mode
            const subtitle = document.getElementById('header-subtitle');
            if (subtitle) {
                subtitle.textContent = currentMode === 'nmc' ? 'Bed Occupancy & Hospital Statistics (NMC View)' : 'Bed Occupancy & Hospital Statistics';
            }

            const reportTabBtn = document.getElementById('report-tab');
            if (reportTabBtn) {
                reportTabBtn.textContent = currentMode === 'nmc' ? 'Department Report' : 'Ward Report';
            }

            const layoutTitle = document.getElementById('ward-layout-title');
            const layoutSub = document.getElementById('ward-layout-subtitle');
            if (layoutTitle && layoutSub) {
                if (currentMode === 'nmc') {
                    layoutTitle.textContent = 'Department Occupancy Layout';
                    layoutSub.textContent = 'Live bed occupancy per department';
                } else {
                    layoutTitle.textContent = 'Ward Occupancy Layout';
                    layoutSub.textContent = 'Live bed occupancy per ward — grouped by block & floor';
                }
            }

            loadDashboardData();
            loadReportData();
        };
    });
}

const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        stopAutoRefresh();
        localStorage.removeItem('user');
        currentUser = null;
        initAuth();
    });
}

// Setup modal event listeners
const modalClose = document.getElementById('modal-close');
const deptModalClose = document.getElementById('dept-modal-close');
const modalEditBtn = document.getElementById('modal-edit-btn');
if (modalClose) {
    modalClose.addEventListener('click', closeWardModal);
}
if (deptModalClose) {
    deptModalClose.addEventListener('click', closeDeptModal);
}
if (modalEditBtn) {
    modalEditBtn.addEventListener('click', () => {
        const wardName = document.getElementById('modal-ward-name').textContent;
        closeWardModal();
        // Redirect logic
        const tabBtn = document.querySelector('[data-tab="bed_entry"]');
        if (tabBtn) tabBtn.click();
        const select = document.getElementById('ward-select');
        if (select) {
            if (typeof wardChoiceInstance !== 'undefined' && wardChoiceInstance) {
                wardChoiceInstance.setChoiceByValue(wardName);
            } else {
                select.value = wardName;
                select.dispatchEvent(new Event('change'));
            }
            document.querySelector('.entry-card').scrollIntoView({ behavior: 'smooth' });
        }
    });
}

// ─── Pastor Services Logic (Inline) ──────────────────────────────────────────
let pastorContacts = [];

async function refreshPastorServices(wardName, isDropdownChange = false) {
    const pastorCard = document.getElementById('pastor-services-card');
    const badge = document.getElementById('pastor-card-ward-badge');
    const openTicketsSection = document.getElementById('pastor-open-tickets-section');
    const openTicketsList = document.getElementById('pastor-open-tickets-list');

    if (!wardName) {
        pastorCard.style.display = 'none';
        return;
    }

    badge.textContent = wardName;
    pastorCard.style.display = 'block';

    if (isDropdownChange) {
        // Reset forms
        document.getElementById('pastor-service-select').value = '';
        document.getElementById('pastor-nurse-id').value = '';
        document.getElementById('pastor-patient-name').value = '';
        document.getElementById('pastor-additional-info').value = '';
        document.getElementById('pastor-create-msg').textContent = '';
        document.getElementById('pastor-close-code').value = '';
        document.getElementById('pastor-close-msg').textContent = '';
        document.getElementById('pastor-close-btn').disabled = true;
        document.getElementById('pastor-close-ticket-id').value = '';
    }

    // Fetch contacts if not already fetched
    if (pastorContacts.length === 0) {
        try {
            const cRes = await axios.get(`${API_BASE}/pastor/contacts`);
            pastorContacts = cRes.data;
        } catch (e) {
            console.error("Failed to load pastor contacts", e);
        }
    }

    // Fetch open tickets
    try {
        const res = await axios.get(`${API_BASE}/pastor/tickets?ward=${encodeURIComponent(wardName)}`);
        const tickets = res.data;

        if (tickets.length > 0) {
            const selectedTicketId = document.getElementById('pastor-close-ticket-id').value;
            openTicketsList.innerHTML = '';
            tickets.forEach(t => {
                const li = document.createElement('li');
                li.className = 'specialty-item';
                if (t.Ticket_ID === selectedTicketId) {
                    li.style.background = 'rgba(26, 115, 232, 0.05)';
                }
                li.innerHTML = `
                    <div style="display:flex; flex-direction:column;">
                        <span class="specialty-name">${t.Service_Type}</span>
                        <span style="font-size: 11px; color: var(--secondary-color);">Ref: ${t.Ticket_ID.slice(-6)} • Opened: ${t.Timestamp_Opened.split(' ')[1]}</span>
                    </div>
                    <button class="btn btn-sm btn-outline-dashed select-ticket-btn" data-id="${t.Ticket_ID}">Select to Close</button>
                `;
                openTicketsList.appendChild(li);
            });

            document.querySelectorAll('.select-ticket-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    document.getElementById('pastor-close-ticket-id').value = e.target.getAttribute('data-id');
                    const codeInput = document.getElementById('pastor-close-code');
                    codeInput.focus();

                    // Highlight selected ticket
                    document.querySelectorAll('.specialty-item').forEach(li => li.style.background = 'transparent');
                    e.target.closest('.specialty-item').style.background = 'rgba(26, 115, 232, 0.05)';

                    if (codeInput.value.length === 4) {
                        document.getElementById('pastor-close-btn').disabled = false;
                    }
                });
            });

            openTicketsSection.style.display = 'block';
        } else {
            openTicketsSection.style.display = 'none';
        }
    } catch (err) {
        console.error("Failed to load pastor tickets", err);
    }
}

// Global listeners for Pastor actions (since IDs are persistent in Bed Entry tab)
document.addEventListener('DOMContentLoaded', () => {
    const pastorServiceSelect = document.getElementById('pastor-service-select');
    const pastorServiceOtherGroup = document.getElementById('pastor-service-other-group');
    const pastorServiceOtherInput = document.getElementById('pastor-service-other');

    if (pastorServiceSelect) {
        pastorServiceSelect.addEventListener('change', (e) => {
            if (e.target.value === 'Other') {
                pastorServiceOtherGroup.style.display = 'block';
            } else {
                pastorServiceOtherGroup.style.display = 'none';
            }
        });
    }

    const pastorSubmitBtn = document.getElementById('pastor-submit-btn');
    if (pastorSubmitBtn) {
        pastorSubmitBtn.addEventListener('click', async () => {
            const wardName = document.getElementById('pastor-card-ward-badge').textContent;
            let service = document.getElementById('pastor-service-select').value;
            const nurseId = document.getElementById('pastor-nurse-id').value.trim();
            const patientName = document.getElementById('pastor-patient-name').value.trim();
            const additionalInfo = document.getElementById('pastor-additional-info').value.trim();
            const msgEl = document.getElementById('pastor-create-msg');

            if (service === 'Other') {
                const otherService = pastorServiceOtherInput.value.trim();
                if (!otherService) {
                    msgEl.textContent = 'Please specify the other service.';
                    msgEl.className = 'status-msg text-red';
                    return;
                }
                service = `Other: ${otherService}`;
            }

            if (!service || !nurseId || !patientName || !additionalInfo) {
                msgEl.textContent = 'Please fill in all fields (Service, Nurse ID, Patient Name, Additional Info).';
                msgEl.className = 'status-msg text-red';
                return;
            }

            pastorSubmitBtn.disabled = true;
            pastorSubmitBtn.textContent = 'Creating Ticket...';

            try {
                const res = await axios.post(`${API_BASE}/pastor/ticket/create`, {
                    Ward_Name: wardName,
                    Service_Type: service,
                    Nurse_ID: nurseId,
                    Patient_Name: patientName,
                    Additional_Info: additionalInfo
                });

                if (res.data.success) {
                    const successText = 'Ticket created and pastors notified via Telegram! Awaiting closure code.';
                    msgEl.textContent = successText;
                    msgEl.className = 'status-msg text-green';
                    alert(successText);
                    document.getElementById('pastor-patient-name').value = '';
                    document.getElementById('pastor-service-select').value = '';
                    document.getElementById('pastor-additional-info').value = '';
                    if (pastorServiceOtherInput) pastorServiceOtherInput.value = '';
                    if (pastorServiceOtherGroup) pastorServiceOtherGroup.style.display = 'none';

                    // Refresh ticket list after a short delay, keeping UI state
                    setTimeout(() => refreshPastorServices(wardName, false), 2000);
                    setTimeout(() => refreshPastorServices(wardName, false), 5000); // Check again to handle Sheets delay
                } else {
                    msgEl.textContent = res.data.message || 'Failed to create ticket.';
                    msgEl.className = 'status-msg text-red';
                }
            } catch (err) {
                msgEl.textContent = 'Error connecting to server.';
                msgEl.className = 'status-msg text-red';
            }
            pastorSubmitBtn.disabled = false;
            pastorSubmitBtn.textContent = 'Create Ticket & Notify';
        });
    }

    const pastorCloseCodeInput = document.getElementById('pastor-close-code');
    const pastorCloseBtn = document.getElementById('pastor-close-btn');

    if (pastorCloseCodeInput) {
        pastorCloseCodeInput.addEventListener('input', (e) => {
            const tId = document.getElementById('pastor-close-ticket-id').value;
            if (e.target.value.length === 4 && tId) {
                pastorCloseBtn.disabled = false;
            } else {
                pastorCloseBtn.disabled = true;
            }
        });
    }

    if (pastorCloseBtn) {
        pastorCloseBtn.addEventListener('click', async () => {
            const ticketId = document.getElementById('pastor-close-ticket-id').value;
            const code = document.getElementById('pastor-close-code').value;
            const msgEl = document.getElementById('pastor-close-msg');
            const wardName = document.getElementById('pastor-card-ward-badge').textContent;

            if (!ticketId || code.length < 4) return;

            pastorCloseBtn.disabled = true;
            pastorCloseBtn.textContent = 'Closing...';

            try {
                const res = await axios.post(`${API_BASE}/pastor/ticket/close`, {
                    Ticket_ID: ticketId,
                    Unique_Code: code
                });

                if (res.data.success) {
                    msgEl.textContent = 'Ticket closed successfully.';
                    msgEl.className = 'status-msg text-green';
                    setTimeout(() => refreshPastorServices(wardName, true), 1500);
                } else {
                    msgEl.textContent = res.data.message || 'Invalid code.';
                    msgEl.className = 'status-msg text-red';
                    pastorCloseBtn.disabled = false;
                    pastorCloseBtn.textContent = 'Close Ticket';
                }
            } catch (err) {
                msgEl.textContent = err.response?.data?.message || 'Error connecting to server.';
                msgEl.className = 'status-msg text-red';
                pastorCloseBtn.disabled = false;
                pastorCloseBtn.textContent = 'Close Ticket';
            }
        });
    }

    const pastorWardSelect = document.getElementById('pastor-ward-select');
    if (pastorWardSelect) {
        pastorWardSelect.addEventListener('change', () => {
            refreshPastorServices(pastorWardSelect.value, true);
        });
    }
});
// ─── Dashboard Logic ─────────────────────────────────────────────────────────
// ─── Data Loading Guards ─────────────────────────────────────────────────────
async function loadNurseData() {
    try {
        const [bedsRes, deptsRes] = await Promise.all([
            axios.get(`${API_BASE}/bed-status`),
            axios.get(`${API_BASE}/departments`)
        ]);
        allWardsData = bedsRes.data;
        allDepartments = deptsRes.data;
        populateWardSelect(allWardsData);
        populatePastorWardSelect(allWardsData);
    } catch (error) {
        console.error("Error loading nurse data:", error);
    }
}

let fullHistoryData = [];
let liveWardsData = [];

async function loadDashboardData() {
    if (currentUser?.role !== 'admin' && currentUser?.role !== 'nmc') return;
    try {
        const [metricsRes, bedsRes, deptsRes, historyRes] = await Promise.all([
            axios.get(`${API_BASE}/metrics`),
            axios.get(`${API_BASE}/bed-status`),
            axios.get(`${API_BASE}/departments`),
            axios.get(`${API_BASE}/history`)
        ]);

        liveWardsData = bedsRes.data || [];
        allDepartments = deptsRes.data || [];
        fullHistoryData = historyRes.data || [];

        // Determine if we need to show historical or live data
        const dateInput = document.getElementById('filter-date');
        const selectedDate = dateInput ? dateInput.value : '';

        if (selectedDate) {
            allWardsData = getHospitalStateOnDate(selectedDate);
            // We need to re-calculate top-level metrics for the historical date
            const hMetrics = recalculateMetrics(allWardsData);
            updateMetrics(hMetrics);
        } else {
            allWardsData = [...liveWardsData];
            updateMetrics(metricsRes.data);
        }

        // Initialize static filters/listeners exactly once
        const blockSelect = document.getElementById('filter-block');
        if (blockSelect && !blockSelect.dataset.initialized) {
            if (dateInput) {
                // Set max date to today
                const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                dateInput.max = today;

                // Allow filtering up to 30 days back
                const pastDate = new Date();
                pastDate.setDate(pastDate.getDate() - 30);
                dateInput.min = pastDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

                dateInput.addEventListener('change', () => {
                    loadDashboardData(); // Reload everything based on the new date
                });
            }

            // Mark as initialized and attach listeners
            blockSelect.dataset.initialized = "true";
            initFilterListeners();
        }

        // Always populate filters to reflect current mode/data
        populateDashboardFilters(liveWardsData);

        if (currentMode === 'nmc') {
            renderDepartmentCards(allWardsData);
        } else {
            renderWardCards(allWardsData);
        }
        renderCharts(allWardsData);
        populateWardSelect(liveWardsData);
        populatePastorWardSelect(liveWardsData);
        populateTransferDropdowns(liveWardsData);

        // Apply filters to refresh visuals with the newly populated options and potential historical data
        applyFilters();

        // Update the "Last Updated" badge with the latest entry from history
        updateLastUpdateBadge(fullHistoryData);
    } catch (error) {
        console.error('Error loading dashboard:', error);
    }
}

/**
 * Updates the header badge with the latest data entry time from History
 */
function updateLastUpdateBadge(history) {
    const badge = document.getElementById('last-update-status');
    if (!badge || !history || history.length === 0) {
        if (badge) badge.style.display = 'none';
        return;
    }

    try {
        // Safe date parse helper (handles "YYYY-MM-DD HH:mm:ss" across browsers)
        const parseTS = (ts) => {
            if (!ts || typeof ts !== 'string') return 0;
            const iso = ts.replace(' ', 'T');
            const d = new Date(iso);
            return isNaN(d.getTime()) ? 0 : d.getTime();
        };

        // Find the record with the most recent timestamp
        const latestEntry = history.reduce((prev, current) => {
            return (parseTS(current.Timestamp) > parseTS(prev.Timestamp)) ? current : prev;
        }, history[0]);

        const latestTS = parseTS(latestEntry.Timestamp);
        if (latestTS > 0) {
            const ts = new Date(latestTS);

            // Format time: HH:mm AM/PM
            const timeStr = ts.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            });

            // Calculate relative date (Today/Yesterday/Date)
            const now = new Date();
            // Compare dates at midnight IST to find the day difference
            const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            const istEntry = new Date(ts.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

            istNow.setHours(0, 0, 0, 0);
            istEntry.setHours(0, 0, 0, 0);

            const diffDays = Math.round((istNow - istEntry) / 86400000);
            let dateLabel = "";

            dateLabel = ts.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

            const ward = latestEntry.Ward_Name || '';
            badge.textContent = `Latest Entry: ${dateLabel}, ${timeStr} (${ward})`;
            badge.title = `Full Timestamp: ${ts.toLocaleString('en-IN')}`;
            badge.style.display = 'flex';
        }
    } catch (e) {
        console.error("Error updating recency badge:", e);
        if (badge) badge.style.display = 'none';
    }
}

function recalculateMetrics(data) {
    let total_beds = 0, occupied = 0, nmc_total = 0;

    data.forEach(w => {
        total_beds += (parseInt(w.sanctioned_beds) || 0);
        occupied += (parseInt(w.Total_Occupied) || 0);
    });

    if (allDepartments) {
        allDepartments.forEach(d => {
            nmc_total += (parseInt(d.nmc_beds) || 0);
        });
    }

    const vacant = Math.max(0, total_beds - occupied);
    const occupancy_rate = total_beds > 0 ? ((occupied / total_beds) * 100).toFixed(2) : "0.00";
    return { total_beds, occupied, vacant, occupancy_rate, nmc_total };
}

function getHospitalStateOnDate(targetDateStr) {
    if (!fullHistoryData || fullHistoryData.length === 0) return [...liveWardsData];

    // Build the latest known state for each ward up to and including the target date
    const stateMap = {};
    const targetDate = new Date(targetDateStr);
    // Move to end of target day for inclusive comparison
    targetDate.setHours(23, 59, 59, 999);

    // Sort history oldest-to-newest so the latest record for a ward accurately overwrites older ones
    const sortedHistory = [...fullHistoryData].sort((a, b) => new Date(a.Date) - new Date(b.Date));

    sortedHistory.forEach(record => {
        let recDateStr = record.Date;
        if (recDateStr) {
            try {
                const dateObj = new Date(recDateStr);
                if (!isNaN(dateObj) && dateObj <= targetDate) {
                    // It's a valid record on or before our target date
                    stateMap[record.Ward_Name] = record;
                }
            } catch (e) { }
        }
    });

    // Clone live data structure so we keep the blocks/floors/specialties intact
    const historicalWards = JSON.parse(JSON.stringify(liveWardsData));

    historicalWards.forEach(ward => {
        const histRecord = stateMap[ward.Ward_Name];
        if (histRecord) {
            // Apply historical numbers
            ward.Occupancy = parseInt(histRecord.Own_Occupied) || 0;
            ward.External_Specialty_Patients = parseInt(histRecord.Cross_Specialty_Occupied) || 0;
            ward.Total_Occupied = parseInt(histRecord.Total_Occupied) || 0;
            ward.Vacant_Beds = parseInt(histRecord.Vacant) || 0;
            ward.sanctioned_beds = parseInt(histRecord.Total_Sanctioned) || parseInt(ward.sanctioned_beds) || 0;
            ward.Cross_Specialty_Name = histRecord.Cross_Specialty_Details || "";
            ward.EMPID = histRecord.EMPID || "Unknown";

            if (ward.sanctioned_beds > 0) {
                ward.Occupancy_Percentage = (ward.Total_Occupied / ward.sanctioned_beds) * 100;
            } else {
                ward.Occupancy_Percentage = 0;
            }
        } else {
            // No history on or before this date implies it was empty/0
            ward.Occupancy = 0;
            ward.External_Specialty_Patients = 0;
            ward.Total_Occupied = 0;
            ward.Vacant_Beds = parseInt(ward.sanctioned_beds) || 0;
            ward.Cross_Specialty_Name = "";
            ward.Occupancy_Percentage = 0;
        }
    });

    return historicalWards;
}

// ─── Dashboard Filters ───────────────────────────────────────────────────────

function initFilterListeners() {
    const blockSelect = document.getElementById('filter-block');
    const floorSelect = document.getElementById('filter-floor');
    const deptSelect = document.getElementById('filter-dept');
    const unitSelect = document.getElementById('filter-unit');
    const wardSelect = document.getElementById('filter-ward');
    const clearBtn = document.getElementById('btn-clear-filters');

    if (blockSelect) blockSelect.addEventListener('change', applyFilters);
    if (floorSelect) floorSelect.addEventListener('change', applyFilters);
    if (wardSelect) wardSelect.addEventListener('change', applyFilters);

    if (deptSelect) {
        deptSelect.addEventListener('change', (e) => {
            const dept = e.target.value;
            unitSelect.innerHTML = '<option value="all">All Units</option>';

            if (dept === 'all') {
                unitSelect.disabled = true;
            } else {
                unitSelect.disabled = false;
                const deptObj = allDepartments.find(d => d.name === dept);
                const count = deptObj ? deptObj.units : 1;
                let baseUnits = Array.from({ length: count }, (_, i) => (i + 1).toString());

                baseUnits.forEach(u => {
                    const opt = document.createElement('option');
                    opt.value = u;
                    opt.textContent = `${dept} ${u}`;
                    unitSelect.appendChild(opt);
                });
            }
            applyFilters();
        });
    }

    if (unitSelect) unitSelect.addEventListener('change', applyFilters);

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (blockSelect) blockSelect.value = 'all';
            if (floorSelect) floorSelect.value = 'all';
            if (deptSelect) deptSelect.value = 'all';
            if (wardSelect) wardSelect.value = 'all';
            if (unitSelect) {
                unitSelect.innerHTML = '<option value="all">All Units</option>';
                unitSelect.disabled = true;
            }

            const dateInput = document.getElementById('filter-date');
            if (dateInput && dateInput.value !== '') {
                dateInput.value = '';
                loadDashboardData(); // Re-trigger live data load
            } else {
                applyFilters();
            }
        });
    }
}

function populateDashboardFilters(data) {
    const blockSelect = document.getElementById('filter-block');
    const floorSelect = document.getElementById('filter-floor');
    const deptSelect = document.getElementById('filter-dept');
    const wardSelect = document.getElementById('filter-ward');

    if (!blockSelect || !floorSelect || !deptSelect || !wardSelect) return;

    // Save current selections
    const prevBlock = blockSelect.value;
    const prevFloor = floorSelect.value;
    const prevDept = deptSelect.value;
    const prevWard = wardSelect.value;

    // Clear existing options except the first 'All' option
    blockSelect.innerHTML = '<option value="all">All Blocks</option>';
    floorSelect.innerHTML = '<option value="all">All Floors</option>';
    deptSelect.innerHTML = '<option value="all">All Departments</option>';
    wardSelect.innerHTML = '<option value="all">All Wards</option>';

    // Get unique blocks
    let blocks = Array.from(new Set(data.map(w => w.Block || 'Other')));

    // In NMC mode, remove G Block as requested (using robust string matching)
    if (currentMode === 'nmc') {
        blocks = blocks.filter(b => {
            const up = b.toUpperCase();
            return !up.startsWith('G') && !up.includes('GERIATRIC') && !up.includes('GERAITRIC');
        });
    }

    blocks.sort().forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b + ' Block';
        blockSelect.appendChild(opt);
    });

    // Get unique floors
    const floors = new Set(data.map(w => w.Floor || 'Ground Floor'));
    const floorOrder = ["Ground Floor", "1st Floor", "2nd Floor", "3rd Floor", "4th Floor", "5th Floor", "6th Floor", "7th Floor"];
    Array.from(floors).sort((a, b) => floorOrder.indexOf(a) - floorOrder.indexOf(b)).forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        floorSelect.appendChild(opt);
    });

    // Wards
    const wardNames = new Set(data.filter(w => w.Ward_Name).map(w => w.Ward_Name));
    Array.from(wardNames).sort().forEach(w => {
        const opt = document.createElement('option');
        opt.value = w;
        opt.textContent = w;
        wardSelect.appendChild(opt);
    });

    // Departments from allDepartments
    allDepartments.forEach(d => {
        // Only filter out 0-bed departments in NMC mode
        const nmcVal = parseInt(d.nmc_beds) || 0;
        if (currentMode === 'nmc' && nmcVal <= 0) return;

        // Explicitly hide Geriatric from NMC list by name if it somehow passed nmc_beds check
        if (currentMode === 'nmc') {
            const up = d.name.toUpperCase();
            if (up.includes('GERIATRIC') || up.includes('GERAITRIC')) return;
        }

        // Hide Babies(Cradle Bed) as it is merged into Neonatology
        if (d.name === 'Babies(Cradle Bed)') return;

        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = d.name;
        deptSelect.appendChild(opt);
    });

    // Restore selections if they still exist in the new lists
    if (Array.from(blockSelect.options).some(o => o.value === prevBlock)) blockSelect.value = prevBlock;
    if (Array.from(floorSelect.options).some(o => o.value === prevFloor)) floorSelect.value = prevFloor;
    if (Array.from(deptSelect.options).some(o => o.value === prevDept)) deptSelect.value = prevDept;
    if (Array.from(wardSelect.options).some(o => o.value === prevWard)) wardSelect.value = prevWard;

    // Synchronize filters to the Report tab as well
}


function applyFilters() {
    console.log("APPLYING FILTERS. MODE:", currentMode);
    const block = document.getElementById('filter-block').value;
    const floor = document.getElementById('filter-floor').value;
    const dept = document.getElementById('filter-dept').value;
    const unit = document.getElementById('filter-unit').value;
    const ward = document.getElementById('filter-ward').value;

    let filtered = allWardsData;

    if (block !== 'all') {
        filtered = filtered.filter(w => (w.Block || 'Other') === block);
    }
    if (floor !== 'all') {
        filtered = filtered.filter(w => (w.Floor || 'Ground Floor') === floor);
    }
    if (ward !== 'all') {
        filtered = filtered.filter(w => w.Ward_Name === ward);
    }
    if (dept !== 'all') {
        const isNeo = dept.toLowerCase() === 'neonatology';
        filtered = filtered.filter(w => {
            let match = false;
            // Check main specialty fallback
            const rowDept = (w.Specialty || '').toLowerCase();
            if (rowDept === dept.toLowerCase() || (isNeo && rowDept === 'babies(cradle bed)')) {
                if (unit === 'all') match = true;
            }

            // Check cross specialties which contains unit info
            if (w.Cross_Specialty_Name) {
                try {
                    const cross = JSON.parse(w.Cross_Specialty_Name);
                    for (let specKey of Object.keys(cross)) {
                        const sk = specKey.toLowerCase();
                        const targetMatch = unit === 'all' ? dept.toLowerCase() : `${dept} ${unit}`.toLowerCase();

                        if (sk.startsWith(targetMatch) || (isNeo && sk.startsWith('babies(cradle bed)'))) {
                            match = true;
                            break;
                        }
                    }
                } catch (e) { }
            }
            return match;
        });
    }

    // Helper to get patients matching filter in a ward
    const getCountForWard = (ward, dFilter = dept, uFilter = unit) => {
        let count = 0;
        const targetDept = dFilter.toLowerCase();
        const targetUnit = uFilter.toLowerCase();

        // Special mapping: If Neonatology is selected, also look for "Babies(Cradle Bed)"
        const isNeoFilter = targetDept === 'neonatology';

        const isMatch = (spec) => {
            const s = (spec || '').toLowerCase();
            if (s === targetDept) return true;
            if (isNeoFilter && s === 'babies(cradle bed)') return true;
            return false;
        };

        if (ward.Specialty && (dFilter === 'all' || (uFilter === 'all' && isMatch(ward.Specialty)))) {
            count += (parseInt(ward.Occupancy) || 0);
        } else if (dFilter === 'all') {
            count += (parseInt(ward.Occupancy) || 0);
        }

        if (ward.Cross_Specialty_Name) {
            try {
                const cross = JSON.parse(ward.Cross_Specialty_Name);
                for (let [specKey, specCount] of Object.entries(cross)) {
                    const sk = specKey.toLowerCase();
                    const fullTarget = uFilter === 'all' ? targetDept : `${targetDept} ${targetUnit}`;

                    let match = false;
                    if (dFilter === 'all') {
                        match = true;
                    } else if (uFilter === 'all') {
                        if (sk.startsWith(targetDept) || (isNeoFilter && sk.startsWith('babies(cradle bed)'))) {
                            match = true;
                        }
                    } else {
                        if (sk === fullTarget) match = true;
                        // For Babies we don't have units specifically requested to map by unit, but if it starts with it, we include it
                        if (isNeoFilter && sk.startsWith('babies(cradle bed)')) match = true;
                    }

                    if (match) {
                        count += (parseInt(specCount) || 0);
                    }
                }
            } catch (e) { }
        }
        return count;
    };

    const getBabiesForWard = (ward) => {
        let count = 0;
        const babyName = 'babies(cradle bed)';
        if (ward.Specialty && ward.Specialty.toLowerCase() === babyName) {
            count += (parseInt(ward.Occupancy) || 0);
        }
        if (ward.Cross_Specialty_Name) {
            try {
                const cross = JSON.parse(ward.Cross_Specialty_Name);
                for (let [specKey, specCount] of Object.entries(cross)) {
                    if (specKey.toLowerCase().startsWith(babyName)) {
                        count += (parseInt(specCount) || 0);
                    }
                }
            } catch (e) { }
        }
        return count;
    };

    const total_beds = filtered.reduce((acc, w) => acc + (parseInt(w.sanctioned_beds) || 0), 0);
    const occupied = filtered.reduce((acc, w) => acc + getCountForWard(w), 0);
    const babiesOccupied = filtered.reduce((acc, w) => acc + getBabiesForWard(w), 0);

    // ── NMC Total (de-duplicated by department name, based on column D nmc_beds) ──
    let nmcTotal = 0;
    let nmcOccupied = 0;
    let nmcCommonOccupied = 0;
    let nmcPrivateOccupied = 0;
    let nmcPwOccupied = 0;
    let nmcCwOccupied = 0;
    if (allDepartments) {
        const isDeptFiltered = (dept !== 'all');
        const isRegionalFiltered = (block !== 'all' || floor !== 'all' || ward !== 'all');

        // De-duplicate: pick the highest nmc_beds value per base department name
        // (multiple units share the same base name in the spreadsheet)
        const seenDepts = new Map(); // baseName -> nmc_beds
        allDepartments.forEach(d => {
            const baseName = d.name.replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim().toLowerCase();
            const nmcVal = parseInt(d.nmc_beds) || 0;
            if (!seenDepts.has(baseName) || nmcVal > seenDepts.get(baseName)) {
                seenDepts.set(baseName, nmcVal);
            }
        });

        // Apply department & regional filters
        const deptBaseFilter = dept === 'all' ? 'all' : dept.replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim().toLowerCase();

        seenDepts.forEach((nmcVal, baseName) => {
            const isBaby = baseName.startsWith('babies');
            const isNeoGroup = (deptBaseFilter === 'neonatology' || deptBaseFilter === 'all') && isBaby;

            if (nmcVal <= 0 && !isNeoGroup) return;

            let match = (baseName === deptBaseFilter);
            if (deptBaseFilter === 'neonatology' && isBaby) match = true;

            if (isDeptFiltered && !match) return;

            if (isRegionalFiltered) {
                const hasMatchingWard = filtered.some(w =>
                    (w.Specialty && w.Specialty.toLowerCase().replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim() === baseName) ||
                    (w.Cross_Specialty_Name && w.Cross_Specialty_Name.toLowerCase().includes(baseName))
                );
                if (hasMatchingWard) nmcTotal += nmcVal;
            } else {
                nmcTotal += nmcVal;
            }
        });

        // Build strict NMC-allowed department base set (for common/private split)
        const nmcAllowedBase = new Set();
        allDepartments.forEach(d => {
            const base = d.name.replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim().toLowerCase();
            const nmcVal = parseInt(d.nmc_beds) || 0;
            const isBabies = base.startsWith('babies');
            if (nmcVal > 0 || isBabies) nmcAllowedBase.add(base);
        });

        // Compute NMC-specific occupied count + dynamic Common/Private split from live entries
        allDepartments.forEach(d => {
            const sName = d.name;
            const sLower = sName.toLowerCase();
            const nmcVal = parseInt(d.nmc_beds) || 0;
            const lDept = dept.toLowerCase();
            const sLowerIsBaby = sLower.startsWith('babies');
            const isNeonatalGroup = (lDept === 'neonatology' || lDept === 'all') && sLowerIsBaby;

            // Count occupancy even if nmcVal is 0, IF it's part of the neonatal group being viewed
            if (nmcVal <= 0 && !isNeonatalGroup) return;

            // Apply Department Filter
            const depMatch = sLower.startsWith(lDept);
            const babyMatch = (lDept === 'neonatology' && sLowerIsBaby);

            if (isDeptFiltered && !depMatch && !babyMatch) return;

            filtered.forEach(w => {
                // Own specialty check (must match unit if unit is filtered)
                if (w.Specialty && w.Specialty.toLowerCase() === sLower) {
                    if (unit === 'all') {
                        nmcOccupied += (parseInt(w.Occupancy) || 0);
                    }
                }

                if (w.Cross_Specialty_Name) {
                    try {
                        const cross = JSON.parse(w.Cross_Specialty_Name);
                        for (let [spec, cnt] of Object.entries(cross)) {
                            const parsed = parseCrossSpecKey(spec);
                            const sk = parsed.baseSpecUnit.toLowerCase();
                            const target = unit === 'all' ? sLower : `${sLower} ${unit}`;
                            const value = (parseInt(cnt) || 0);

                            if (unit === 'all') {
                                if (sk.startsWith(sLower)) {
                                    nmcOccupied += value;
                                }
                            } else {
                                if (sk === target) {
                                    nmcOccupied += value;
                                }
                            }
                        }
                    } catch (e) { }
                }
            });
        });

        // Single-pass dynamic split (no duplicate counting from nested department loops)
        let hasExplicitBedTypeInContext = false;
        filtered.forEach(w => {
            if (!w.Cross_Specialty_Name) return;
            try {
                const cross = JSON.parse(w.Cross_Specialty_Name);
                for (let [spec, cnt] of Object.entries(cross)) {
                    const parsed = parseCrossSpecKey(spec);
                    const sk = parsed.baseSpecUnit.toLowerCase();
                    const value = (parseInt(cnt) || 0);

                    // count only explicit bed-type rows
                    if (parsed.bedType !== 'common' && parsed.bedType !== 'private') continue;

                    // Respect current dept/unit filter context
                    if (dept !== 'all') {
                        const deptLower = dept.toLowerCase();
                        const target = unit === 'all' ? deptLower : `${deptLower} ${unit}`;
                        const match = (unit === 'all') ? sk.startsWith(deptLower) : (sk === target);
                        if (!match) continue;
                    }

                    // Keep only NMC-listed bases
                    const crossBase = sk.replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim();
                    if (!nmcAllowedBase.has(crossBase)) continue;

                    hasExplicitBedTypeInContext = true;
                    if (parsed.bedType === 'common') {
                        nmcCommonOccupied += value;
                        nmcCwOccupied += value;
                    }
                    if (parsed.bedType === 'private') {
                        nmcPrivateOccupied += value;
                        nmcPwOccupied += value;
                    }
                }
            } catch (e) { }
        });

        // strict guard: if no explicit bed-type entries exist for current context, force zero split
        if (!hasExplicitBedTypeInContext) {
            nmcCommonOccupied = 0;
            nmcPrivateOccupied = 0;
            nmcPwOccupied = 0;
            nmcCwOccupied = 0;
        }
    }

    const vacant = Math.max(0, total_beds - occupied);
    const nmcVacant = Math.max(0, nmcTotal - nmcOccupied);
    const occupancy_rate = total_beds > 0 ? ((occupied / total_beds) * 100).toFixed(1) : 0;
    const nmc_occupancy_rate = nmcTotal > 0 ? ((nmcOccupied / nmcTotal) * 100).toFixed(1) : 0;

    updateMetrics({
        total_beds,
        occupied: currentMode === 'nmc' ? nmcOccupied : occupied,
        babiesOccupied,
        vacant: currentMode === 'nmc' ? nmcVacant : vacant,
        occupancy_rate: currentMode === 'nmc' ? nmc_occupancy_rate : occupancy_rate,
        nmc_total: nmcTotal,
        filtered_wards: filtered,
        nmc_common_occupied: nmcCommonOccupied,
        nmc_private_occupied: nmcPrivateOccupied,
        nmc_pw_occupied: nmcPwOccupied,
        nmc_cw_occupied: nmcCwOccupied
    });
    renderCharts(filtered);

    if (currentMode === 'nmc') {
        renderDepartmentCards(filtered);
    } else {
        renderWardCards(filtered);
    }
}

function renderDepartmentCards(data) {
    const container = document.getElementById('ward-cards-container');
    if (!container) return;
    container.innerHTML = '';

    // We use allDepartments as the base to show all sanctioned departments
    if (!allDepartments || allDepartments.length === 0) return;

    const deptFilter = document.getElementById('filter-dept')?.value || 'all';
    const unitFilter = document.getElementById('filter-unit')?.value || 'all';

    // Grid for departments
    const grid = document.createElement('div');
    grid.className = 'ward-grid-layout mt-2';

    allDepartments.forEach(d => {
        const sName = d.name;
        const sLower = sName.toLowerCase();

        // Skip Babies(Cradle Bed) card itself, as it is merged into Neonatology
        if (sLower === 'babies(cradle bed)') return;

        // Aggregation: If we are Neonatology, we also count Babies(Cradle Bed)
        const isNeo = sLower === 'neonatology';

        let nmcBeds = parseInt(d.nmc_beds) || 0;
        if (isNeo) {
            const babiesDept = allDepartments.find(ad => ad.name === 'Babies(Cradle Bed)');
            if (babiesDept) {
                nmcBeds += (parseInt(babiesDept.nmc_beds) || 0);
            }
        }

        // Filter check: If in NMC mode, only show departments with sanctioned NMC beds
        if (currentMode === 'nmc' && nmcBeds <= 0) return;

        // Manual filter check if a department is selected
        if (deptFilter !== 'all' && sLower !== deptFilter.toLowerCase()) return;

        // Calculate occupancy for this department across the filtered wards (data)
        let deptOccupancy = 0;
        let babiesCount = 0;

        const checkMatch = (spec) => {
            if (!spec) return false;
            const l = spec.toLowerCase();
            if (l === sLower) return true;
            if (isNeo && l === 'babies(cradle bed)') return true;
            return false;
        };

        const isBabiesOnly = (spec) => {
            if (!spec) return false;
            return spec.toLowerCase() === 'babies(cradle bed)';
        };

        data.forEach(w => {
            // Own specialty
            if (w.Specialty && checkMatch(w.Specialty)) {
                if (unitFilter === 'all') {
                    const occ = (parseInt(w.Occupancy) || 0);
                    deptOccupancy += occ;
                    if (isNeo && isBabiesOnly(w.Specialty)) babiesCount += occ;
                }
            }
            // Cross specialty
            if (w.Cross_Specialty_Name) {
                try {
                    const cross = JSON.parse(w.Cross_Specialty_Name);
                    for (let [spec, count] of Object.entries(cross)) {
                        const parsed = parseCrossSpecKey(spec);
                        const sk = parsed.baseSpecUnit.toLowerCase();
                        const target = unitFilter === 'all' ? sLower : `${sLower} ${unitFilter}`;

                        if (unitFilter === 'all') {
                            if (sk.startsWith(sLower) || (isNeo && sk.startsWith('babies(cradle bed)'))) {
                                const occ = (parseInt(count) || 0);
                                deptOccupancy += occ;
                                if (isNeo && sk.startsWith('babies(cradle bed)')) babiesCount += occ;
                            }
                        } else {
                            if (sk === target) {
                                const occ = (parseInt(count) || 0);
                                deptOccupancy += occ;
                            }
                        }
                    }
                } catch (e) { }
            }
        });

        // Calculate daycare for this department across the filtered wards
        let daycareGF = 0;
        let daycareOnc = 0;

        data.forEach(w => {
            if (w.Daycare_Details) {
                try {
                    const dc = JSON.parse(w.Daycare_Details);
                    for (let [specKey, count] of Object.entries(dc)) {
                        const parts = specKey.split('|');
                        const baseSpecUnit = parts[0];
                        const dcType = parts[1];
                        const sk = baseSpecUnit.toLowerCase();
                        const target = unitFilter === 'all' ? sLower : `${sLower} ${unitFilter}`;

                        let isMatch = false;
                        if (unitFilter === 'all') {
                            if (sk.startsWith(sLower) || (isNeo && sk.startsWith('babies(cradle bed)'))) {
                                isMatch = true;
                            }
                        } else {
                            if (sk === target) {
                                isMatch = true;
                            }
                        }

                        if (isMatch) {
                            const val = parseInt(count) || 0;
                            if (dcType === 'gf') daycareGF += val;
                            if (dcType === 'onc') daycareOnc += val;
                        }
                    }
                } catch (e) { }
            }
        });

        // Calculate breakdown of wards for this department (respecting unit filter)
        const wardBreakdown = [];
        data.forEach(w => {
            let wardCount = 0;
            if (w.Specialty && checkMatch(w.Specialty)) {
                if (unitFilter === 'all') {
                    wardCount += (parseInt(w.Occupancy) || 0);
                }
            }
            if (w.Cross_Specialty_Name) {
                try {
                    const cross = JSON.parse(w.Cross_Specialty_Name);
                    for (let [spec, count] of Object.entries(cross)) {
                        const parsed = parseCrossSpecKey(spec);
                        const sk = parsed.baseSpecUnit.toLowerCase();
                        const target = unitFilter === 'all' ? sLower : `${sLower} ${unitFilter}`;

                        if (unitFilter === 'all') {
                            if (sk.startsWith(sLower) || (isNeo && sk.startsWith('babies(cradle bed)'))) {
                                wardCount += (parseInt(count) || 0);
                            }
                        } else {
                            if (sk === target) {
                                wardCount += (parseInt(count) || 0);
                            }
                        }
                    }
                } catch (e) { }
            }
            if (wardCount > 0) {
                wardBreakdown.push({ name: w.Ward_Name, count: wardCount });
            }
        });

        const pct = nmcBeds > 0 ? ((deptOccupancy / nmcBeds) * 100).toFixed(2) : "0.00";
        let occClass = 'low-occ';
        if (pct > 80) occClass = 'high-occ';
        else if (pct >= 50) occClass = 'mid-occ';

        const card = document.createElement('div');
        card.className = `ward-card ${occClass} dept-card`;
        card.onclick = () => {
            openDeptModal(sName, wardBreakdown, nmcBeds, deptOccupancy, daycareGF, daycareOnc);
        };

        const babiesSub = isNeo && babiesCount > 0 ? `<small class="babies-label">(Incl. ${babiesCount} Cradle Bed)</small>` : '';

        let daycareSubStatsHTML = '';
        if (daycareGF > 0 || daycareOnc > 0) {
            daycareSubStatsHTML = `
                <div class="stat" style="grid-column: span 3; border-top: 1px dashed var(--border-color); padding-top: 4px; margin-top: 4px; display: flex; justify-content: space-between;">
                    <span>Daycare:</span>
                    <span style="font-weight: 600; font-size: 11px; color: var(--secondary-color);">
                        ${daycareGF > 0 ? `GF: <b>${daycareGF}</b> ` : ''}
                        ${daycareOnc > 0 ? `Onc: <b>${daycareOnc}</b>` : ''}
                    </span>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="card-top">
                <span class="ward-name">${sName}</span>
                <span class="ward-code">DEPT</span>
            </div>
            <div class="card-main">
                <div class="occupancy-display">
                    <span class="pct-text">${pct}%</span>
                    <div class="mini-bar-bg">
                        <div class="mini-bar-fill" style="width: ${Math.min(pct, 100)}%"></div>
                    </div>
                </div>
            </div>
            <div class="card-stats">
                <div class="stat"><span>NMC Beds</span><b>${nmcBeds}</b></div>
                <div class="stat"><span>Patients</span><b>${deptOccupancy} ${babiesSub}</b></div>
                <div class="stat"><span>Vacant</span><b>${Math.max(0, nmcBeds - deptOccupancy)}</b></div>
                ${daycareSubStatsHTML}
            </div>
        `;
        grid.appendChild(card);
    });

    container.appendChild(grid);
}

function renderWardCards(data) {
    const container = document.getElementById('ward-cards-container');
    if (!container) return;
    container.innerHTML = '';

    if (!data || data.length === 0) {
        container.innerHTML = '<div class="no-data-msg mt-2">No matching wards found for current filters.</div>';
        return;
    }

    const groups = {};
    const allBlocks = new Set();
    const allFloors = new Set();

    data.forEach(w => {
        const blk = w.Block || 'Other';
        const flr = w.Floor || 'Ground Floor';
        allBlocks.add(blk);
        allFloors.add(flr);

        if (!groups[blk]) groups[blk] = {};
        if (!groups[blk][flr]) groups[blk][flr] = [];
        groups[blk][flr].push(w);
    });

    // Dynamic sorting
    const blockOrder = Array.from(allBlocks).sort((a, b) => {
        if (a === 'Other') return 1;
        if (b === 'Other') return -1;
        return a.localeCompare(b);
    });

    const standardFloors = ["Ground Floor", "1st Floor", "2nd Floor", "3rd Floor", "4th Floor", "5th Floor", "6th Floor", "7th Floor"];
    const floorOrder = Array.from(allFloors).sort((a, b) => {
        const idxA = standardFloors.indexOf(a);
        const idxB = standardFloors.indexOf(b);

        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;

        // Fallback to numeric or alpha sort for unknown floors
        const numA = parseInt(a);
        const numB = parseInt(b);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
    });

    blockOrder.forEach(block => {
        if (!groups[block]) return;

        const blockId = block.split('(')[0].trim();
        const blockSection = document.createElement('section');
        blockSection.className = 'block-section mt-2';
        blockSection.innerHTML = `
            <div class="block-header">
                <span class="block-id">${blockId}</span>
                <h2>${block} Block</h2>
            </div>
            <div class="floors-container"></div>
        `;
        const floorsContainer = blockSection.querySelector('.floors-container');

        floorOrder.forEach(floor => {
            if (!groups[block][floor]) return;

            const floorDiv = document.createElement('div');
            floorDiv.className = 'floor-group';
            floorDiv.innerHTML = `<div class="floor-label">${floor}</div>`;

            const grid = document.createElement('div');
            grid.className = 'ward-grid-layout';

            groups[block][floor].sort((a, b) => a.Ward_Name.localeCompare(b.Ward_Name)).forEach(ward => {
                const pct = (ward.Occupancy_Percentage || 0).toFixed(2);
                let occClass = 'low-occ';
                if (pct > 80) occClass = 'high-occ';
                else if (pct >= 50) occClass = 'mid-occ';

                const card = document.createElement('div');
                card.className = `ward-card ${occClass}`;
                card.onclick = () => {
                    openWardModal(ward);
                };

                let daycareWardHTML = '';
                let wardDaycareGF = 0;
                let wardDaycareOnc = 0;
                if (ward.Daycare_Details) {
                    try {
                        const dc = JSON.parse(ward.Daycare_Details);
                        for (let [key, val] of Object.entries(dc)) {
                            if (key.endsWith('|gf')) wardDaycareGF += (parseInt(val) || 0);
                            if (key.endsWith('|onc')) wardDaycareOnc += (parseInt(val) || 0);
                        }
                    } catch (e) { }
                }
                if (wardDaycareGF > 0 || wardDaycareOnc > 0) {
                    daycareWardHTML = `
                        <div class="stat" style="grid-column: span 3; border-top: 1px dashed var(--border-color); padding-top: 4px; margin-top: 4px; display: flex; justify-content: space-between;">
                            <span>Daycare:</span>
                            <span style="font-weight: 600; font-size: 11px; color: var(--secondary-color);">
                                ${wardDaycareGF > 0 ? `GF: <b>${wardDaycareGF}</b> ` : ''}
                                ${wardDaycareOnc > 0 ? `Onc: <b>${wardDaycareOnc}</b>` : ''}
                            </span>
                        </div>
                    `;
                }

                card.innerHTML = `
                    <div class="card-top">
                        <span class="ward-name">${ward.Ward_Name}</span>
                        <span class="ward-code">${ward.Ward_Code || ''}</span>
                    </div>
                    <div class="card-main">
                        <div class="occupancy-display">
                            <span class="pct-text">${pct}%</span>
                            <div class="mini-bar-bg">
                                <div class="mini-bar-fill" style="width: ${Math.min(pct, 100)}%"></div>
                            </div>
                        </div>
                    </div>
                    <div class="card-stats">
                        <div class="stat"><span>Beds</span><b>${ward.sanctioned_beds}</b></div>
                        <div class="stat"><span>Patients</span><b>${ward.Total_Occupied}</b></div>
                        <div class="stat"><span>Vacant</span><b>${ward.Vacant_Beds}</b></div>
                        ${daycareWardHTML}
                    </div>
                `;
                grid.appendChild(card);
            });
            floorDiv.appendChild(grid);
            floorsContainer.appendChild(floorDiv);
        });
        container.appendChild(blockSection);
    });
}

function updateMetrics(data) {
    const totalEl = document.getElementById('metric-total');
    const occEl = document.getElementById('metric-occupied');
    const vacEl = document.getElementById('metric-vacant');
    const rateEl = document.getElementById('occupancy-pct');

    const deptFilter = document.getElementById('filter-dept')?.value || 'all';
    const unitFilter = document.getElementById('filter-unit')?.value || 'all';
    const blockFilter = document.getElementById('filter-block')?.value || 'all';
    const floorFilter = document.getElementById('filter-floor')?.value || 'all';
    const wardFilter = document.getElementById('filter-ward')?.value || 'all';

    let displayTotal = currentMode === 'nmc' ? (data.nmc_total || 0) : data.total_beds;
    let displayOccupied = data.occupied;

    // UI Labels
    const labelEl = document.getElementById('total-beds-label');
    if (labelEl) {
        labelEl.textContent = currentMode === 'nmc' ? 'Total NMC Bed Count' : 'Total Beds';
    }

    const hospitalCapacity = 1872;

    if (totalEl) totalEl.textContent = displayTotal;

    if (occEl) {
        // Only show babies subcount in overall view
        const lDept = deptFilter.toLowerCase();
        const showBabies = (currentMode !== 'nmc') && (lDept === 'all' || lDept.startsWith('neonatology'));
        const babiesSub = (showBabies && data.babiesOccupied > 0) ? ` <small class="babies-label">(Incl. ${data.babiesOccupied} Cradle Bed)</small>` : '';

        // Show common detail only in NMC view
        const babiesCount = parseInt(data.babiesOccupied || 0);
        const commonSub = (currentMode === 'nmc') ? ` <small class="babies-label">(Incl. ${babiesCount} Cradle Bed Count)</small>` : '';
        const pwNmc = parseInt(data.nmc_pw_occupied || 0);
        const cwNmc = parseInt(data.nmc_cw_occupied || 0);
        const splitCounts = (currentMode === 'nmc')
            ? ` <span style="display:inline-block;margin-top:2px;"><small class="babies-label">PW: ${pwNmc} | CW: ${cwNmc}</small></span>`
            : '';

        occEl.innerHTML = `${displayOccupied}${currentMode === 'nmc' ? (commonSub + splitCounts) : babiesSub}`;
    }

    // For NMC mode, use the calculated NMC total. For Overall mode, use the hospital capacity (1832).
    const capacityDenominator = currentMode === 'nmc' ? displayTotal : hospitalCapacity;

    // Use absolute hospital capacity for vacancy and occupancy %
    const vacant = Math.max(0, capacityDenominator - displayOccupied);
    if (vacEl) vacEl.textContent = vacant;

    const pct = capacityDenominator > 0 ? ((displayOccupied / capacityDenominator) * 100).toFixed(2) : "0.00";
    const rateFuncEl = document.getElementById('occupancy-pct-functional');

    if (currentMode === 'overall') {
        if (rateEl) rateEl.innerHTML = `<b>${pct}%</b> against Total Sanctioned Beds (Infra Beds)`;
        if (rateFuncEl) {
            const funcPct = data.total_beds > 0 ? ((displayOccupied / data.total_beds) * 100).toFixed(2) : "0.00";
            rateFuncEl.innerHTML = `<b>${funcPct}%</b> against Functional beds`;
            rateFuncEl.style.display = 'block';
        }
    } else {
        if (rateEl) rateEl.innerHTML = `<b>${pct}%</b> occupancy`;
        if (rateFuncEl) rateFuncEl.style.display = 'none';
    }

    const vacDenomEl = document.getElementById('vacant-denominator');
    const vacFuncEl = document.getElementById('vacant-functional');

    if (vacDenomEl) {
        vacDenomEl.textContent = currentMode === 'nmc' ? "against Total NMC beds" : "against Total Sanctioned Beds (Infra Beds)";
    }

    if (vacFuncEl) {
        if (currentMode === 'overall') {
            const funcVacant = Math.max(0, data.total_beds - displayOccupied);
            vacFuncEl.innerHTML = `<b>${funcVacant}</b> against Functional beds`;
            vacFuncEl.style.display = 'block';
        } else {
            vacFuncEl.style.display = 'none';
        }
    }

    // Hide/Show Total Beds Card logic
    const totalCard = document.getElementById('total-beds-card');
    const vacantCard = document.getElementById('vacant-beds-card');
    const staticCard = document.getElementById('static-capacity-card');

    const isAnyFilterActive = (deptFilter !== 'all' || unitFilter !== 'all' || blockFilter !== 'all' || floorFilter !== 'all' || wardFilter !== 'all');

    if (currentMode === 'overall') {
        if (staticCard) staticCard.style.display = isAnyFilterActive ? 'none' : 'block';
        if (totalCard) totalCard.style.display = isAnyFilterActive ? 'none' : 'block';
        if (vacantCard) vacantCard.style.display = isAnyFilterActive ? 'none' : 'block';
        if (rateEl) rateEl.style.display = isAnyFilterActive ? 'none' : 'inline';
    } else {
        // NMC Mode
        if (staticCard) staticCard.style.display = 'none';
        if (totalCard) totalCard.style.display = 'block';
        if (vacantCard) vacantCard.style.display = 'block';
        if (rateEl) rateEl.style.display = 'inline';
    }
}

function renderCharts(filteredData) {
    if (!filteredData) return;

    // Current filters
    const deptFilter = document.getElementById('filter-dept')?.value || 'all';
    const wardFilter = document.getElementById('filter-ward')?.value || 'all';
    const blockFilter = document.getElementById('filter-block')?.value || 'all';
    const floorFilter = document.getElementById('filter-floor')?.value || 'all';
    const unitFilter = document.getElementById('filter-unit')?.value || 'all';

    // 1. Regional Distribution Charts (Dynamic Blocks)
    const blockDepts = {};
    const blockSanctioned = {};
    const blocksFound = new Set();

    // Identify all blocks present in the data
    allWardsData.forEach(w => {
        blocksFound.add((w.Block || 'Other').toUpperCase());
    });
    const sortedBlocks = Array.from(blocksFound).sort();
    sortedBlocks.forEach(blk => {
        blockDepts[blk] = {};
        blockSanctioned[blk] = 0;
    });

    allWardsData.forEach(w => {
        // Respect context filters (Block, Floor, Ward) but NOT Dept/Unit
        if (blockFilter !== 'all' && (w.Block || 'Other') !== blockFilter) return;
        if (floorFilter !== 'all' && (w.Floor || 'Ground Floor') !== floorFilter) return;
        if (wardFilter !== 'all' && w.Ward_Name !== wardFilter) return;

        const blk = (w.Block || 'Other').toUpperCase();
        const cleaner = (s) => s.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');

        // Track capacity
        blockSanctioned[blk] += (parseInt(w.sanctioned_beds) || 0);

        if (w.Specialty) {
            let groupName = w.Specialty.replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim();
            // Mapping Babies to Neonatology
            if (groupName === 'Babies(Cradle Bed)') groupName = 'Neonatology';

            const sClean = cleaner(groupName);
            blockDepts[blk][sClean] = (blockDepts[blk][sClean] || 0) + (parseInt(w.Occupancy) || 0);
        }
        if (w.Cross_Specialty_Name) {
            try {
                const cross = JSON.parse(w.Cross_Specialty_Name);
                for (let [spec, count] of Object.entries(cross)) {
                    let groupName = spec.replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim();
                    // Mapping Babies to Neonatology
                    if (groupName === 'Babies(Cradle Bed)') groupName = 'Neonatology';

                    const sClean = cleaner(groupName);
                    blockDepts[blk][sClean] = (blockDepts[blk][sClean] || 0) + (parseInt(count) || 0);
                }
            } catch (e) { }
        }
    });

    // Identify active blocks (those with sanctioned capacity)
    let activeBlocks = sortedBlocks.filter(blk => blockSanctioned[blk] > 0);

    // In NMC mode, remove G Block chart as requested (using robust string matching)
    if (currentMode === 'nmc') {
        activeBlocks = activeBlocks.filter(blk => {
            const up = blk.trim().toUpperCase();
            return !up.startsWith('G') && !up.includes('GERIATRIC');
        });
    }

    const dynamicContainer = document.getElementById('dynamic-block-charts');
    if (dynamicContainer) {
        const activeBlockIds = activeBlocks.map(b => b.replace(/[^A-Z0-9]/gi, '_'));

        // Remove charts that are no longer active
        Object.keys(charts).forEach(key => {
            if (key.startsWith('block_') && !activeBlockIds.includes(key.replace('block_', ''))) {
                if (typeof charts[key].destroy === 'function') charts[key].destroy();
                delete charts[key];
                const el = document.getElementById(`container-${key}`);
                if (el) el.remove();
            }
        });

        // Ensure each active block has a container and canvas
        activeBlocks.forEach(blk => {
            const safeId = blk.replace(/[^A-Z0-9]/gi, '_');
            const nameMap = {
                'G': 'G (GERIATRIC)',
                'A': 'A BLOCK',
                'B': 'B BLOCK',
                'C': 'C BLOCK'
            };
            const displayBlk = nameMap[blk.toUpperCase()] || blk;

            let container = document.getElementById(`container-block_${safeId}`);
            if (!container) {
                container = document.createElement('div');
                container.id = `container-block_${safeId}`;
                container.className = 'block-chart-item';
                container.innerHTML = `
                    <h4 class="chart-label">BLOCK ${displayBlk}</h4>
                    <canvas id="chart-block_${safeId}"></canvas>
                `;
                dynamicContainer.appendChild(container);
            } else {
                // Update title if it exists
                const label = container.querySelector('.chart-label');
                if (label) label.textContent = `BLOCK ${displayBlk}`;
            }
        });
    }

    // A more harmonious, professional palette
    const palette = ['#4285F4', '#34A853', '#EA4335', '#FBBC05', '#24C1E0', '#A142F4', '#FF6D01', '#607D8B'];

    const updateBlockChart = (blkName, chartKey) => {
        const safeId = blkName.replace(/[^A-Z0-9]/gi, '_');
        const canvas = document.getElementById(`chart-block_${safeId}`);
        if (!canvas) return;

        const depts = blockDepts[blkName];
        let labels = [];
        let values = [];
        let backgroundColors = [];

        const capacity = blockSanctioned[blkName] || 0;
        const totalBlockCount = Object.values(depts).reduce((a, b) => a + b, 0);

        if (totalBlockCount === 0 && capacity === 0) {
            // Only destroy if there's no data AND no capacity
            if (charts[chartKey]) charts[chartKey].destroy();
            delete charts[chartKey];
            return;
        }

        if (deptFilter !== 'all' && wardFilter === 'all') {
            const cleaner = (s) => s.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
            const targetClean = cleaner(deptFilter);

            let targetCount = depts[targetClean] || 0;
            let otherCount = totalBlockCount - targetCount;

            labels = [targetClean, 'Others'];
            values = [targetCount, otherCount];
            backgroundColors = [getDeptColor(targetClean), '#E8EAED'];
        } else {
            labels = Object.keys(depts);
            values = Object.values(depts);
            backgroundColors = labels.map(l => getDeptColor(l));

            // Add Vacant segment to show full capacity (applied to both SJMCH and NMC)
            const capacity = blockSanctioned[blkName] || 0;
            const vacantCount = Math.max(0, capacity - totalBlockCount);
            if (vacantCount > 0) {
                labels.push('Vacant');
                values.push(vacantCount);
                backgroundColors.push('#E8EAED'); // Light gray for vacancy
            }
        }

        if (charts[chartKey] && typeof charts[chartKey].update === 'function') {
            charts[chartKey].data.labels = labels;
            charts[chartKey].data.datasets[0].data = values;
            charts[chartKey].data.datasets[0].backgroundColor = backgroundColors;
            charts[chartKey].update();
        } else {
            if (charts[chartKey]) charts[chartKey].destroy();
            charts[chartKey] = new Chart(canvas, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: values,
                        backgroundColor: backgroundColors
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '70%',
                    layout: {
                        padding: {
                            top: 10,
                            bottom: 10,
                            left: 10,
                            right: 10
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const pct = total > 0 ? ((context.parsed / total) * 100).toFixed(2) : "0.00";
                                    return `${context.label}: ${context.parsed} (${pct}%)`;
                                }
                            }
                        }
                    }
                }
            });
        }
    };

    activeBlocks.forEach(blk => {
        updateBlockChart(blk, `block_${blk.replace(/[^A-Z0-9]/gi, '_')}`);
    });

    // 2. Specialty Chart (Show all, highlight filtered)
    const specialties = {};
    const cleaner = (s) => s.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');

    if (currentMode === 'nmc') {
        const unitF = document.getElementById('filter-unit')?.value || 'all';
        allDepartments.forEach(dept => {
            const sName = dept.name;
            const sLower = sName.toLowerCase();
            const isNeonatalGroup = sLower.startsWith('babies');

            if (dept.nmc_beds > 0 || isNeonatalGroup) {
                let deptOccupancy = 0;
                // Use allWardsData to ensure we get global occupancy for this chart
                allWardsData.forEach(w => {
                    if (w.Specialty && w.Specialty.toLowerCase() === sLower && unitF === 'all') {
                        deptOccupancy += (parseInt(w.Occupancy) || 0);
                    }
                    if (w.Cross_Specialty_Name) {
                        try {
                            const cross = JSON.parse(w.Cross_Specialty_Name);
                            for (let [spec, count] of Object.entries(cross)) {
                                const sk = spec.toLowerCase();
                                const target = unitF === 'all' ? sLower : `${sLower} ${unitF}`;

                                if (unitF === 'all') {
                                    if (sk.startsWith(sLower)) {
                                        deptOccupancy += (parseInt(count) || 0);
                                    }
                                } else {
                                    if (sk === target) {
                                        deptOccupancy += (parseInt(count) || 0);
                                    }
                                }
                            }
                        } catch (e) { }
                    }
                });

                let groupName = sName.replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim();
                // Mapping Babies to Neonatology
                if (groupName === 'Babies(Cradle Bed)') groupName = 'Neonatology';

                const sClean = cleaner(groupName);
                specialties[sClean] = (specialties[sClean] || 0) + deptOccupancy;
            }
        });
    } else {
        allWardsData.forEach(w => {
            if (w.Specialty) {
                let groupName = w.Specialty;
                // Mapping Babies to Neonatology
                if (groupName === 'Babies(Cradle Bed)') groupName = 'Neonatology';

                const sClean = cleaner(groupName);
                specialties[sClean] = (specialties[sClean] || 0) + (parseInt(w.Occupancy) || 0);
            }
            if (w.Cross_Specialty_Name) {
                try {
                    const cross = JSON.parse(w.Cross_Specialty_Name);
                    for (let [spec, count] of Object.entries(cross)) {
                        let groupName = spec.replace(/\s+\d+$/g, '').replace(/-\d+$/g, '').replace(/\s+unit\s+\d+$/gi, '').trim();
                        // Mapping Babies to Neonatology
                        if (groupName === 'Babies(Cradle Bed)') groupName = 'Neonatology';

                        const sClean = cleaner(groupName);
                        specialties[sClean] = (specialties[sClean] || 0) + (parseInt(count) || 0);
                    }
                } catch (e) { }
            }
        });
    }

    const topSpecs = Object.entries(specialties)
        .filter(s => s[1] > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30);

    const specLabels = topSpecs.map(s => s[0]);
    const specValues = topSpecs.map(s => s[1]);

    // Color logic: if filter is active, highlight the filtered bar, others gray.
    const activeDept = deptFilter !== 'all' ? cleaner(deptFilter) : null;
    const backgroundColors = specLabels.map(label => {
        const baseColor = getDeptColor(label);
        if (!activeDept) return baseColor;
        return label === activeDept ? baseColor : 'rgba(200, 200, 200, 0.3)'; // Highlight vs Muted
    });
    const borderColors = specLabels.map(label => {
        const baseColor = getDeptColor(label);
        if (!activeDept) return baseColor;
        return label === activeDept ? baseColor : 'rgba(150, 150, 150, 0.3)';
    });

    const specCanvas = document.getElementById('specialtyChart');
    if (specCanvas) {
        // Increase height for better visibility
        const fixedHeight = 320;
        const container = specCanvas.closest('.specialty-chart-container');
        if (container) {
            container.style.height = `${fixedHeight}px`;
        }

        // Dynamic bar thickness: Wider when a filter is active to emphasize the highlight
        const dynamicBarThickness = activeDept ? 20 : 8;

        if (charts.spec && typeof charts.spec.update === 'function') {
            charts.spec.data.labels = specLabels;
            charts.spec.data.datasets[0].data = specValues;
            charts.spec.data.datasets[0].backgroundColor = backgroundColors;
            charts.spec.data.datasets[0].borderColor = borderColors;
            charts.spec.data.datasets[0].barThickness = dynamicBarThickness;
            charts.spec.data.datasets[0].label = currentMode === 'nmc' ? 'Bed Capacity' : 'Patients';
            charts.spec.update();
        } else {
            if (charts.spec) charts.spec.destroy();
            charts.spec = new Chart(specCanvas, {
                type: 'bar',
                data: {
                    labels: specLabels,
                    datasets: [{
                        label: currentMode === 'nmc' ? 'Bed Capacity' : 'Patients',
                        data: specValues,
                        backgroundColor: backgroundColors,
                        borderColor: borderColors,
                        borderWidth: 1,
                        borderRadius: 4,
                        categoryPercentage: 0.9,
                        barPercentage: 1.0,
                        barThickness: dynamicBarThickness
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    indexAxis: 'x',
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: '#202124',
                            titleFont: { size: 13, weight: '600' },
                            padding: 12,
                            cornerRadius: 8,
                            displayColors: false,
                            callbacks: {
                                label: function (context) {
                                    return `${context.dataset.label}: ${context.parsed.y}`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: { display: false },
                            ticks: {
                                maxRotation: 45,
                                minRotation: 45,
                                autoSkip: true,
                                font: { size: 10 }
                            },
                            title: {
                                display: true,
                                text: 'Departments',
                                font: { weight: '800', size: 11 }
                            }
                        },
                        y: {
                            grid: { display: false },
                            beginAtZero: true,
                            ticks: {
                                font: { weight: '700', size: 10 }
                            },
                            title: {
                                display: true,
                                text: 'Number of patients',
                                font: { weight: '800', size: 11 }
                            }
                        }
                    }
                }
            });
        }
    }

    // Render Day-wise Occupancy Chart
    renderDailyOccupancyChart();
}

async function renderDailyOccupancyChart(filteredLiveWards) {
    const chartContainer = document.getElementById('daily-occupancy-container');
    const canvas = document.getElementById('dailyOccupancyChart');
    if (!chartContainer || !canvas) return;

    if (!fullHistoryData || fullHistoryData.length === 0) {
        chartContainer.style.display = 'none';
        return;
    }

    const deptFilter = document.getElementById('filter-dept')?.value || 'all';
    const unitFilter = document.getElementById('filter-unit')?.value || 'all';
    const blockFilter = document.getElementById('filter-block')?.value || 'all';
    const floorFilter = document.getElementById('filter-floor')?.value || 'all';
    const wardFilter = document.getElementById('filter-ward')?.value || 'all';

    const targetDept = deptFilter.toLowerCase();
    const targetUnit = unitFilter.toLowerCase();
    const isNeoFilter = targetDept === 'neonatology';

    // 1. Collect unique days from history
    const dailyDates = new Set();
    fullHistoryData.forEach(r => {
        if (r.Date) dailyDates.add(r.Date);
    });

    let sortedDates = Array.from(dailyDates);

    // Filter to only focus on data from March 15th onwards
    const cutoffDate = new Date("2026-03-15T00:00:00");
    sortedDates = sortedDates.filter(dateStr => {
        try {
            const d = new Date(dateStr);
            return !isNaN(d) && d >= cutoffDate;
        } catch (e) { return false; }
    });

    sortedDates.sort((a, b) => new Date(a) - new Date(b));

    // 2. Helper to compute Occupancy matching the Dashboard Logic
    const calculateOccupancy = (historicalWards) => {
        // Apply Block, Floor, Ward filters
        let filtered = historicalWards;
        if (blockFilter !== 'all') filtered = filtered.filter(w => (w.Block || 'Other') === blockFilter);
        if (floorFilter !== 'all') filtered = filtered.filter(w => (w.Floor || 'Ground Floor') === floorFilter);
        if (wardFilter !== 'all') filtered = filtered.filter(w => w.Ward_Name === wardFilter);

        // Apply Dept/Unit filters
        if (deptFilter !== 'all') {
            filtered = filtered.filter(w => {
                let match = false;
                const rowDept = (w.Specialty || '').toLowerCase();
                if (rowDept === targetDept || (isNeoFilter && rowDept === 'babies(cradle bed)')) match = unitFilter === 'all';
                if (w.Cross_Specialty_Name) {
                    try {
                        const cross = JSON.parse(w.Cross_Specialty_Name);
                        for (let specKey of Object.keys(cross)) {
                            const sk = specKey.toLowerCase();
                            const fullTarget = unitFilter === 'all' ? targetDept : `${targetDept} ${targetUnit}`;
                            if (sk.startsWith(fullTarget) || (isNeoFilter && sk.startsWith('babies(cradle bed)'))) {
                                match = true; break;
                            }
                        }
                    } catch (e) { }
                }
                return match;
            });
        }

        if (currentMode === 'overall') {
            // Overall occupancy sum for filtered wards
            let occ = 0;
            let cap = 0;
            filtered.forEach(ward => {
                cap += (parseInt(ward.sanctioned_beds) || 0);

                if (ward.Specialty && (deptFilter === 'all' || (unitFilter === 'all' && (ward.Specialty.toLowerCase() === targetDept || (isNeoFilter && ward.Specialty.toLowerCase() === 'babies(cradle bed)'))))) {
                    occ += (parseInt(ward.Occupancy) || 0);
                } else if (deptFilter === 'all') {
                    occ += (parseInt(ward.Occupancy) || 0);
                }
                if (ward.Cross_Specialty_Name) {
                    try {
                        const cross = JSON.parse(ward.Cross_Specialty_Name);
                        for (let [specKey, specCount] of Object.entries(cross)) {
                            const sk = specKey.toLowerCase();
                            const fullTarget = unitFilter === 'all' ? targetDept : `${targetDept} ${targetUnit}`;
                            let match = false;
                            if (deptFilter === 'all') match = true;
                            else if (unitFilter === 'all' && (sk.startsWith(targetDept) || (isNeoFilter && sk.startsWith('babies(cradle bed)')))) match = true;
                            else if (sk === fullTarget || (isNeoFilter && sk.startsWith('babies(cradle bed)'))) match = true;
                            if (match) occ += (parseInt(specCount) || 0);
                        }
                    } catch (e) { }
                }
            });
            return { occupied: occ, capacity: cap };
        } else {
            // NMC occupancy sum
            let nmcOcc = 0;
            let nmcCap = 0;
            allDepartments.forEach(d => {
                const sLower = d.name.toLowerCase();
                const nmcVal = parseInt(d.nmc_beds) || 0;
                const sLowerIsBaby = sLower.startsWith('babies');
                const isNeonatalGroup = (targetDept === 'neonatology' || targetDept === 'all') && sLowerIsBaby;

                if (nmcVal <= 0 && !isNeonatalGroup) return;

                if (deptFilter !== 'all' && !sLower.startsWith(targetDept) && !(targetDept === 'neonatology' && sLowerIsBaby)) return;

                nmcCap += nmcVal;

                filtered.forEach(w => {
                    if (w.Specialty && w.Specialty.toLowerCase() === sLower && unitFilter === 'all') {
                        nmcOcc += (parseInt(w.Occupancy) || 0);
                    }
                    if (w.Cross_Specialty_Name) {
                        try {
                            const cross = JSON.parse(w.Cross_Specialty_Name);
                            for (let [spec, cnt] of Object.entries(cross)) {
                                const sk = spec.toLowerCase();
                                const target = unitFilter === 'all' ? sLower : `${sLower} ${targetUnit}`;
                                if (unitFilter === 'all' && sk.startsWith(sLower)) nmcOcc += (parseInt(cnt) || 0);
                                else if (sk === target) nmcOcc += (parseInt(cnt) || 0);
                            }
                        } catch (e) { }
                    }
                });
            });
            return { occupied: nmcOcc, capacity: nmcCap };
        }
    };

    // 3. Populate Array
    const dailyTotals = {};
    for (let dateStr of sortedDates) {
        const histWards = getHospitalStateOnDate(dateStr);
        dailyTotals[dateStr] = calculateOccupancy(histWards);
    }

    // Include Today
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (!sortedDates.includes(todayStr)) sortedDates.push(todayStr);

    // Always use the true live occupancy for the "today" point
    dailyTotals[todayStr] = calculateOccupancy(liveWardsData);

    sortedDates.sort((a, b) => new Date(a) - new Date(b));

    const labels = sortedDates.map(dateStr => {
        try {
            const d = new Date(dateStr);
            if (!isNaN(d)) return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch (e) { }
        return dateStr;
    });

    const values = sortedDates.map(date => dailyTotals[date].occupied);
    const pointColors = sortedDates.map(date => {
        const dataPoint = dailyTotals[date];
        if (dataPoint.capacity <= 0) return '#ea4335'; // Red if no capacity/division by 0
        const pct = (dataPoint.occupied / dataPoint.capacity) * 100;
        return pct > 80 ? '#34a853' : (pct >= 50 ? '#f29900' : '#ea4335');
    });

    chartContainer.style.display = 'block';

    if (charts.dailyOccupancy && typeof charts.dailyOccupancy.update === 'function') {
        charts.dailyOccupancy.data.labels = labels;
        charts.dailyOccupancy.data.datasets[0].data = values;
        charts.dailyOccupancy.data.datasets[0].pointBackgroundColor = pointColors;
        charts.dailyOccupancy.update();
    } else {
        if (charts.dailyOccupancy) charts.dailyOccupancy.destroy();
        charts.dailyOccupancy = new Chart(canvas, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Total Occupied Beds',
                    data: values,
                    borderColor: '#4285F4',
                    backgroundColor: 'rgba(66, 133, 244, 0.1)',
                    borderWidth: 2,
                    pointBackgroundColor: pointColors,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    fill: true,
                    tension: 0.3 // Smooth curves
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#202124',
                        titleFont: { size: 13, weight: '600' },
                        padding: 12,
                        cornerRadius: 8,
                        displayColors: false,
                        callbacks: {
                            label: function (context) {
                                return context.parsed.y + ' Patients';
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            font: { weight: '600', size: 11 },
                            maxRotation: 45,
                            minRotation: 45
                        }
                    },
                    y: {
                        grid: {
                            color: 'rgba(0, 0, 0, 0.05)',
                            drawBorder: false
                        },
                        beginAtZero: true,
                        ticks: {
                            font: { weight: '600', size: 11 },
                            precision: 0
                        },
                        title: {
                            display: true,
                            text: 'Number of Patients',
                            font: { weight: '800', size: 11 }
                        }
                    }
                }
            }
        });
    }
}

// ─── Bed Entry Logic ─────────────────────────────────────────────────────────
function populateWardSelect(data) {
    const select = document.getElementById('ward-select');
    if (!select || !data) return;

    const currentValue = select.value;

    let filteredWards = data;
    if (currentUser.role !== 'admin' && currentUser.role !== 'nmc' && currentUser.ward !== 'All') {
        filteredWards = data.filter(w => w.Ward_Name === currentUser.ward);
    }

    const newWardNames = filteredWards.map(w => w.Ward_Name).sort();
    const existingWardNames = Array.from(select.options)
        .map(o => o.value)
        .filter(v => v !== "")
        .sort();

    // Only rebuild if the list of wards has actually changed
    const isDifferent = newWardNames.length !== existingWardNames.length ||
        newWardNames.some((name, i) => name !== existingWardNames[i]);

    if (!isDifferent && select.options.length > 1) {
        // Just make sure the value is still set correctly (in case it was reset elsewhere)
        if (typeof wardChoiceInstance !== 'undefined' && wardChoiceInstance && currentValue) {
            wardChoiceInstance.setChoiceByValue(currentValue);
        } else if (select.value !== currentValue) {
            select.value = currentValue;
        }
        return;
    }

    if (typeof wardChoiceInstance !== 'undefined' && wardChoiceInstance) {
        const choices = [{ value: '', label: '-- Select Ward --', disabled: false }];
        newWardNames.forEach(name => {
            choices.push({ value: name, label: name });
        });
        wardChoiceInstance.setChoices(choices, 'value', 'label', true);
        if (currentValue) {
            wardChoiceInstance.setChoiceByValue(currentValue);
        }
    } else {
        select.innerHTML = '<option value="">-- Select Ward --</option>';
        filteredWards.sort((a, b) => a.Ward_Name.localeCompare(b.Ward_Name))
            .forEach(w => {
                const opt = document.createElement('option');
                opt.value = w.Ward_Name;
                opt.textContent = w.Ward_Name;
                select.appendChild(opt);
            });
        if (currentValue) select.value = currentValue;
    }
}

function populatePastorWardSelect(data) {
    const select = document.getElementById('pastor-ward-select');
    if (!select || !data) return;

    const currentValue = select.value;
    let filteredWards = data;
    if (currentUser && currentUser.role !== 'admin' && currentUser.role !== 'nmc' && currentUser.ward !== 'All') {
        filteredWards = data.filter(w => w.Ward_Name === currentUser.ward);
    }

    const newWardNames = filteredWards.map(w => w.Ward_Name).sort();

    // We won't use Choices.js here to keep it simple, just standard select
    select.innerHTML = '<option value="">-- Choose a Ward --</option>';
    filteredWards.sort((a, b) => a.Ward_Name.localeCompare(b.Ward_Name))
        .forEach(w => {
            const opt = document.createElement('option');
            opt.value = w.Ward_Name;
            opt.textContent = w.Ward_Name;
            select.appendChild(opt);
        });
    if (newWardNames.includes(currentValue)) {
        select.value = currentValue;
    }
}

function populateTransferDropdowns(data) {
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'nmc') || !data) return;
    const source = document.getElementById('transfer-source');
    const target = document.getElementById('transfer-target');

    if (source && target) {
        [source, target].forEach(el => {
            const currentValue = el.value;
            const newWardNames = data.map(w => w.Ward_Name).sort();
            const existingWardNames = Array.from(el.options)
                .map(o => o.value)
                .filter(v => v !== "")
                .sort();

            const isDifferent = newWardNames.length !== existingWardNames.length ||
                newWardNames.some((name, i) => name !== existingWardNames[i]);

            if (!isDifferent && el.options.length > 1) {
                if (el.value !== currentValue) el.value = currentValue;
                return;
            }

            el.innerHTML = '<option value="">-- Ward --</option>';
            data.slice().sort((a, b) => a.Ward_Name.localeCompare(b.Ward_Name))
                .forEach(w => {
                    const opt = document.createElement('option');
                    opt.value = w.Ward_Name;
                    opt.textContent = w.Ward_Name;
                    el.appendChild(opt);
                });
            if (currentValue) el.value = currentValue;
        });
    }
}

function initForms() {
    const rowContainer = document.getElementById('specialty-rows-container');
    const addRowBtn = document.getElementById('add-specialty-row');

    function updateCalculatedStats() {
        const sancInput = document.getElementById('sanctioned-beds');
        const sanc = sancInput ? parseInt(sancInput.value) || 0 : 0;
        let total = 0;
        document.querySelectorAll('.specialty-row').forEach(row => {
            total += (parseInt(row.querySelector('.row-pw')?.value) || 0)
                + (parseInt(row.querySelector('.row-cw')?.value) || 0);
        });
        const totalOccEl = document.getElementById('total-occupied-display');
        const vacantEl = document.getElementById('vacant-beds-display');
        if (totalOccEl) totalOccEl.value = total;
        if (vacantEl) vacantEl.value = Math.max(0, sanc - total);
    }

    function createRow(spec = '', unit = '', pw = '', cw = '', dcType = '', dcGf = '', dcOnc = '') {
        if (!rowContainer) return;
        const row = document.createElement('div');
        row.className = 'specialty-row';

        const specOptions = allDepartments.map(d => `<option value="${d.name}" ${d.name.toLowerCase() === spec.toLowerCase() ? 'selected' : ''}>${d.name}</option>`).join('');

        function getUnitOptions(selectedSpec) {
            const dept = allDepartments.find(d => d.name === selectedSpec);
            const count = dept ? dept.units : 1;
            let baseUnits = Array.from({ length: count }, (_, i) => (i + 1).toString());

            return baseUnits.map(u => {
                const label = `${selectedSpec} ${u}`;
                return `<option value="${u}" ${u.toString() === unit.toString() ? 'selected' : ''}>${label}</option>`;
            }).join('');
        }

        const unitOptions = getUnitOptions(spec);
        const initialDcVal = dcGf || dcOnc || '';

        row.innerHTML = `
            <div class="form-group">
                <label>Department</label>
                <select class="row-spec">
                    <option value="">-- Dept --</option>
                    ${specOptions}
                </select>
            </div>
            <div class="form-group" style="width: 120px;">
                <label>Unit</label>
                <select class="row-unit">
                    <option value="">-- Unit --</option>
                    ${unitOptions}
                </select>
            </div>
            <div class="form-group" style="width: 90px;">
                <label>PW Patients</label>
                <input type="number" class="row-pw" value="${pw}" min="0" placeholder="PW">
            </div>
            <div class="form-group" style="width: 90px;">
                <label>CW Patients</label>
                <input type="number" class="row-cw" value="${cw}" min="0" placeholder="CW">
            </div>
            <div class="form-group" style="width: 130px;">
                <label>Daycare</label>
                <select class="row-daycare-type">
                    <option value="">-- Daycare --</option>
                    <option value="gf" ${dcType === 'gf' ? 'selected' : ''}>Daycare Ground Floor</option>
                    <option value="onc" ${dcType === 'onc' ? 'selected' : ''}>Daycare Oncology</option>
                </select>
            </div>
            <div class="form-group row-daycare-count-container" style="width: 100px; display: ${dcType ? 'block' : 'none'};">
                <label>Daycare Patients</label>
                <input type="number" class="row-daycare-count" value="${initialDcVal}" min="0" placeholder="Patients">
            </div>
            <button type="button" class="btn-remove">&times;</button>
        `;
        let rowChoiceInstance = null;

        row.querySelector('.btn-remove').onclick = () => {
            if (rowChoiceInstance) rowChoiceInstance.destroy();
            row.remove();
            updateCalculatedStats();
        };
        const specSelect = row.querySelector('.row-spec');
        const unitSelect = row.querySelector('.row-unit');

        if (typeof Choices !== 'undefined') {
            rowChoiceInstance = new Choices(specSelect, {
                searchEnabled: true,
                itemSelectText: '',
                shouldSort: false,
                placeholder: true
            });
        }

        specSelect.addEventListener('change', () => {
            unitSelect.innerHTML = `<option value="">-- Unit --</option>${getUnitOptions(specSelect.value)}`;
            updateCalculatedStats();
        });

        const daycareTypeSelect = row.querySelector('.row-daycare-type');
        const daycareCountContainer = row.querySelector('.row-daycare-count-container');
        const daycareCountInput = row.querySelector('.row-daycare-count');

        daycareTypeSelect.addEventListener('change', () => {
            const val = daycareTypeSelect.value;
            if (val) {
                daycareCountContainer.style.display = 'block';
            } else {
                daycareCountContainer.style.display = 'none';
                daycareCountInput.value = '';
            }
            updateCalculatedStats();
        });

        row.querySelectorAll('input, select').forEach(input => {
            if (input !== specSelect && input !== daycareTypeSelect) { // onchange already handled for specSelect & daycareTypeSelect
                input.onchange = updateCalculatedStats;
            }
            input.oninput = updateCalculatedStats;
        });
        rowContainer.appendChild(row);
    }

    if (addRowBtn) addRowBtn.onclick = () => createRow();

    const wardSelect = document.getElementById('ward-select');
    if (wardSelect) {
        if (typeof Choices !== 'undefined') {
            wardChoiceInstance = new Choices(wardSelect, {
                searchEnabled: true,
                itemSelectText: '',
                shouldSort: false,
                placeholder: true,
                placeholderValue: '-- Select Ward --'
            });
        }

        wardSelect.addEventListener('change', () => {
            const ward = allWardsData.find(w => w.Ward_Name === wardSelect.value);
            if (ward) {
                document.getElementById('entry-block').value = ward.Block || '';
                document.getElementById('entry-floor').value = ward.Floor || '';
                document.getElementById('sanctioned-beds').value = ward.sanctioned_beds || 0;
                document.getElementById('entry-date').value = new Date().toISOString().split('T')[0];

                if (rowContainer) rowContainer.innerHTML = '';

                // User wants a blank slate for today's data entry
                // Only provide one empty row for the main specialty
                createRow(ward.Specialty || '', '', '');

                document.getElementById('entry-notes').value = '';
                const commonWardBedCountInput = document.getElementById('common-ward-bed-count');
                if (commonWardBedCountInput) {
                    const existingCommonWardCount = parseInt(ward.Common_Ward_Bed_Count, 10);
                    commonWardBedCountInput.value = Number.isNaN(existingCommonWardCount) ? '0' : String(existingCommonWardCount);
                }
                updateCalculatedStats();
            }
        });
    }

    const empIdInput = document.getElementById('emp-id');
    if (empIdInput) {
        empIdInput.addEventListener('input', (e) => {
            // Convert to uppercase and restrict to alphanumeric (A-Z, 0-9)
            e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        });
    }

    const sancBedsInput = document.getElementById('sanctioned-beds');
    if (sancBedsInput) sancBedsInput.oninput = updateCalculatedStats;

    const entryForm = document.getElementById('ward-entry-form');
    if (entryForm) {
        entryForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = entryForm.querySelector('button[type="submit"]');
            const status = document.getElementById('save-status');

            // Prevent double submission
            if (submitBtn) submitBtn.disabled = true;

            const specialties = [];
            document.querySelectorAll('.specialty-row').forEach(row => {
                const spec = row.querySelector('.row-spec').value;
                const unit = row.querySelector('.row-unit').value;
                const pw = parseInt(row.querySelector('.row-pw')?.value) || 0;
                const cw = parseInt(row.querySelector('.row-cw')?.value) || 0;
                const dcType = row.querySelector('.row-daycare-type')?.value || '';
                const dcGf = parseInt(row.querySelector('.row-daycare-gf')?.value) || 0;
                const dcOnc = parseInt(row.querySelector('.row-daycare-onc')?.value) || 0;
                if (spec) {
                    specialties.push({
                        specialty: spec,
                        unit,
                        pw_count: pw,
                        cw_count: cw,
                        count: pw + cw,
                        dc_type: dcType,
                        dc_gf: dcGf,
                        dc_onc: dcOnc
                    });
                }
            });

            const payload = {
                Ward_Name: wardSelect.value,
                emp_id: document.getElementById('emp-id').value,
                entry_date: document.getElementById('entry-date').value,
                sanctioned_beds: parseInt(document.getElementById('sanctioned-beds').value),
                common_ward_bed_count: parseInt(document.getElementById('common-ward-bed-count')?.value || '0', 10) || 0,
                specialties: specialties,
                Notes: document.getElementById('entry-notes').value
            };

            let countdown = 5;
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = `Please wait... (${countdown} s)`;
            }

            const timer = setInterval(() => {
                countdown--;
                if (countdown > 0) {
                    if (submitBtn) submitBtn.textContent = `Please wait... (${countdown} s)`;
                } else {
                    clearInterval(timer);
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Submit Update';
                    }
                }
            }, 1000);

            try {
                const res = await axios.post(`${API_BASE}/ward-entry`, payload);
                if (res.data.success) {
                    status.textContent = '✓ Saved successfully';
                    status.className = 'status-msg text-green';
                    setTimeout(() => {
                        status.textContent = '';
                        clearBedEntryForm();
                    }, 3000);
                    loadDashboardData();
                }
            } catch (error) {
                status.textContent = error.response?.data?.message || '✗ Error saving data';
                status.className = 'status-msg text-error';
            }
        });
    }

    const transferForm = document.getElementById('transfer-form');
    if (transferForm) {
        transferForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const status = document.getElementById('transfer-status');
            const payload = {
                source_ward: document.getElementById('transfer-source').value,
                target_ward: document.getElementById('transfer-target').value,
                count: parseInt(document.getElementById('transfer-count').value)
            };

            try {
                const res = await axios.post(`${API_BASE}/transfer`, payload);
                if (res.data.success) {
                    status.textContent = '✓ Transfer successful';
                    status.className = 'status-msg text-green';
                    loadDashboardData();
                }
            } catch (error) {
                status.textContent = error.response?.data?.message || '✗ Transfer failed';
                status.className = 'status-msg text-error';
            }
        });
    }

    const reportDateFilter = document.getElementById('report-date-filter');
    if (reportDateFilter) {
        reportDateFilter.style.display = 'none';
    }

    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            // Case 1: Exporting a filtered report (Historical/Aggregate)
            if (reportViewActive && lastReportData && lastReportData.length > 0) {
                const startStr = document.getElementById('report-start-date')?.value || '';
                const endStr = document.getElementById('report-end-date')?.value || '';
                const deptSelectEl = document.getElementById('report-dept-select');
                const deptFilter = deptSelectEl?.value || 'all';
                let headers = [];
                let rows = [];

                if (currentMode === 'nmc') {
                    if (deptFilter === 'all') {
                        headers = ['Department Name', 'Capacity (NMC)', 'Occupied', 'PW', 'CW', 'Vacant', '%'];
                        rows = lastReportData.map(r => {
                            const cap = (r.capacity !== undefined && r.capacity !== null) ? r.capacity : 0;
                            const occ = r.avgOcc || r.occupied || 0;
                            const pw = r.avgPW || r.pw || 0;
                            const cw = r.avgCW || r.cw || 0;
                            const vac = Math.max(0, cap - occ);
                            const pct = cap > 0 ? (occ / cap * 100).toFixed(2) : '0.00';
                            return [
                                `"${r.department || '-'}"`,
                                cap,
                                occ,
                                pw,
                                cw,
                                vac,
                                `"${pct}%"`
                            ];
                        });
                    } else {
                        // Single department summary
                        headers = ['Period', 'Capacity (NMC)', 'Avg Occupied', 'Avg PW', 'Avg CW', 'Days'];
                        rows = lastReportData.map(r => [
                            `"${r.period}"`,
                            r.capacity || 0,
                            r.avgOcc,
                            r.avgPW || 0,
                            r.avgCW || 0,
                            r.days
                        ]);
                    }
                } else {
                    // SJMCH / Overall Mode
                    headers = ['Ward Name', 'Block', 'Capacity', 'Occupied', 'PW', 'CW', 'Vacant', '%'];
                    rows = lastReportData.map(w => {
                        const cap = w.capacity || w.sanctioned_beds || 0;
                        const occ = w.occ || w.Total_Occupied || 0;
                        const pct = cap > 0 ? (occ / cap * 100).toFixed(2) : '0.00';
                        return [
                            `"${w.ward || w.Ward_Name}"`,
                            `"${w.block || w.Block || '-'}"`,
                            cap,
                            occ,
                            w.pw || w.PW_Occupied || 0,
                            w.cw || w.CW_Occupied || 0,
                            w.vacant || w.Vacant_Beds || 0,
                            `"${pct}%"`
                        ];
                    });
                }

                const dateHeader = `Report Range: ${startStr} to ${endStr}`;
                const csvContent = [dateHeader, headers.join(','), ...rows.map(r => r.join(','))].join('\n');
                const blob = new Blob([csvContent], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;

                let filename = `report_${currentMode}_${deptFilter}.csv`;
                const suffix = currentMode === 'nmc' ? 'NMC' : 'SJMCH';

                if (startStr === endStr) {
                    filename = `daily_report_${startStr}_${suffix}.csv`;
                } else {
                    filename = `range_report_${startStr}_to_${endStr}_${suffix}.csv`;
                }

                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                return;
            }

            // Case 2: Fallback to exporting Live Status (if no report is active)
            if (!allWardsData || allWardsData.length === 0) {
                alert('No data available to export.');
                return;
            }
            const headers = ['Ward Name', 'Block', 'Floor', 'Capacity', 'Occupied', 'PW', 'CW', 'Vacant', '%'];
            const rows = allWardsData.map(w => [
                `"${w.Ward_Name}"`,
                w.Block,
                w.Floor,
                w.sanctioned_beds,
                w.Total_Occupied,
                w.PW_Occupied || 0,
                w.CW_Occupied || 0,
                w.Vacant_Beds,
                Math.round(w.Occupancy_Percentage) || 0
            ]);

            const csvContent = [headers, ...rows].map(r => r.join(',')).join('\n');
            const blob = new Blob([csvContent], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `live_status_${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }
}


// ─── Report Helpers ───────────────────────────────────────────────────────────
function getPeriodKey(dateStr, period) {
    const d = new Date(dateStr + 'T00:00:00');
    if (period === 'daily') return dateStr;
    if (period === 'weekly') {
        const jan1 = new Date(d.getFullYear(), 0, 1);
        const week = Math.ceil((((d - jan1) / 86400000) + jan1.getDay() + 1) / 7);
        return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    if (period === 'monthly') {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[d.getMonth()]} ${d.getFullYear()}`;
    }
    return dateStr;
}

function renderReportChart(periodRows, period) {
    const container = document.getElementById('report-chart-container');
    const canvas = document.getElementById('reportChart');
    if (!container || !canvas) return;

    const deptFilter = document.getElementById('report-dept-select')?.value || 'all';

    // Hide chart if showing all departments in NMC mode (too messy)
    if (currentMode === 'nmc' && deptFilter === 'all') {
        container.style.display = 'none';
        return;
    }

    if (!periodRows || periodRows.length === 0) { container.style.display = 'none'; return; }
    container.style.display = 'block';

    const labels = periodRows.map(r => r.period);
    const pwVals = periodRows.map(r => r.avgPW);
    const cwVals = periodRows.map(r => r.avgCW);

    if (charts.reportChart && typeof charts.reportChart.destroy === 'function') charts.reportChart.destroy();
    charts.reportChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Private Ward (PW)', data: pwVals, backgroundColor: '#4285F4', borderRadius: 4, stack: 'occ' },
                { label: 'Common Ward (CW)', data: cwVals, backgroundColor: '#34A853', borderRadius: 4, stack: 'occ' },
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: 'top' },
                tooltip: {
                    callbacks: {
                        afterBody: (items) => {
                            const total = items.reduce((s, i) => s + i.parsed.y, 0);
                            return [`Total: ${total}`];
                        }
                    }
                }
            },
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 45, minRotation: 30 } },
                y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Avg Occupied Beds', font: { weight: '700', size: 11 } } }
            }
        }
    });
}

// ─── Date-range Analytics Report ─────────────────────────────────────────────
function enforceDateConstraints() {
    // Range constraints removed as per single-date report requirement
    return;
}

function scheduleRunReport() {
    enforceDateConstraints();
    if (reportDebounceTimer) clearTimeout(reportDebounceTimer);
    reportDebounceTimer = setTimeout(() => {
        runReport();
    }, 250);
}

function upsertReportStatus(message, type = 'info') {
    const wrap = document.getElementById('report-chart-container') || document.getElementById('ward-report-tab');
    if (!wrap) return;
    let el = document.getElementById('report-status-msg');
    if (!el) {
        el = document.createElement('div');
        el.id = 'report-status-msg';
        el.style.marginTop = '10px';
        el.style.fontSize = '13px';
        el.style.fontWeight = '600';
        wrap.parentNode.insertBefore(el, wrap.nextSibling);
    }
    const color = type === 'error' ? '#d93025' : (type === 'warn' ? '#f29900' : '#5f6368');
    el.style.color = color;
    el.textContent = message || '';
}

function normalizeDepartmentFilter(raw, deptSelectEl) {
    const v = String(raw || '').trim();
    if (!v) return 'all';
    if (v.toLowerCase() === 'all') return 'all';
    if (!deptSelectEl) return v;

    const opts = Array.from(deptSelectEl.options || []);
    const exact = opts.find(o => (o.value || '').trim().toLowerCase() === v.toLowerCase());
    if (exact) return exact.value;

    const byText = opts.find(o => (o.textContent || '').trim().toLowerCase() === v.toLowerCase());
    if (byText) return byText.value;

    return 'all';
}

async function runReport() {
    if (reportRequestInFlight) return;
    const startStr = String(document.getElementById('report-start-date')?.value || '').trim();
    const endStr = String(document.getElementById('report-end-date')?.value || startStr).trim();
    const period = 'summary';

    // Department filter removed as requested - always show all
    const deptFilter = 'all';

    if (!startStr) {
        if (reportViewActive) {
            upsertReportStatus('Please select a date range.', 'warn');
        }
        return;
    }

    const dateStampTop = document.getElementById('report-date-stamp');
    if (dateStampTop) {
        dateStampTop.textContent = 'Updating data...';
        dateStampTop.style.display = 'inline-block';
    }

    let periodRows = [];
    let res = null;
    reportRequestInFlight = true;
    try {
        console.log('Fetching Report with Params:', {
            start_date: startStr,
            end_date: endStr,
            period: period,
            department: deptFilter,
            mode: currentMode
        });
        res = await axios.get(`${API_BASE}/report-summary`, {
            params: {
                start_date: startStr,
                end_date: endStr,
                period: period,
                department: deptFilter,
                block: 'all',
                floor: 'all',
                mode: currentMode
            }
        });
        console.log('Report Response:', res.data);
        if (!res.data?.success) {
            upsertReportStatus(res.data?.message || 'Failed to fetch report summary.', 'error');
            return;
        }
        periodRows = Array.isArray(res.data.rows) ? res.data.rows : [];
        lastReportData = periodRows;
        reportViewActive = true;
    } catch (e) {
        console.error('Report summary fetch failed:', e);
        upsertReportStatus(e?.response?.data?.message || 'Failed to fetch report summary.', 'error');
        return;
    } finally {
        reportRequestInFlight = false;
    }

    if (!periodRows.length) {
        upsertReportStatus('No data found for selected filters.', 'warn');
    } else {
        upsertReportStatus('');
    }

    // Render table
    const tbody = document.querySelector('#ward-table tbody');
    const thead = document.querySelector('#ward-table thead');
    const title = document.getElementById('report-title');
    const dateStamp = document.getElementById('report-date-stamp');

    if (dateStamp) {
        if (startStr) {
            const dateObjS = new Date(startStr);
            const formattedS = dateObjS.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
            if (endStr && endStr !== startStr) {
                const dateObjE = new Date(endStr);
                const formattedE = dateObjE.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
                dateStamp.textContent = `Showing Data for: ${formattedS} to ${formattedE}`;
            } else {
                dateStamp.textContent = `Showing Data for: ${formattedS}`;
            }
            dateStamp.style.display = 'inline-block';
        } else {
            dateStamp.style.display = 'none';
        }
    }

    if (!tbody || !thead) return;

    const th = (t) => `<th style="padding:12px 15px;font-weight:600;color:#5f6368;background:#f8f9fa;">${t}</th>`;

    if (currentMode === 'nmc') {
        const deptLabel = deptFilter === 'all' ? 'All Departments' : deptFilter;
        if (title) title.textContent = `Department Occupancy Report — ${deptLabel}`;

        if (deptFilter === 'all') {
            thead.innerHTML = `<tr>${['Department Name', 'Capacity (NMC)', 'Occupied', 'PW', 'CW', 'Vacant', '%'].map(th).join('')}</tr>`;
            tbody.innerHTML = '';
            periodRows.forEach(r => {
                // In NMC mode with 'all' filter, backend returns avgOcc, but if it's 1 day, it's the actual count
                const tr = document.createElement('tr');
                const cap = (r.capacity !== undefined && r.capacity !== null) ? r.capacity : 0;
                const occ = r.avgOcc || r.occupied || 0;
                const pw = r.avgPW || r.pw || 0;
                const cw = r.avgCW || r.cw || 0;
                const vac = Math.max(0, cap - occ);
                const pct = cap > 0 ? (occ / cap * 100).toFixed(2) : '0.00';
                tr.innerHTML = `
                    <td>${r.department || '-'}</td>
                    <td>${cap}</td>
                    <td>${occ}</td>
                    <td>${pw}</td>
                    <td>${cw}</td>
                    <td>${vac}</td>
                    <td>${pct}%</td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            // Single department summary
            thead.innerHTML = `<tr>${['Period', 'Avg Occupied', 'Avg PW', 'Avg CW', 'Days'].map(th).join('')}</tr>`;
            tbody.innerHTML = '';
            periodRows.forEach(r => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${r.period}</td><td>${r.avgOcc}</td><td>${r.avgPW}</td><td>${r.avgCW}</td><td>${r.days}</td>`;
                tbody.appendChild(tr);
            });
        }
    } else {
        // Overall / Ward Mode
        if (title) title.textContent = "Ward Occupancy Report";
        thead.innerHTML = `<tr>${['Ward Name', 'Block', 'Capacity', 'Occupied', 'PW', 'CW', 'Vacant', '%'].map(th).join('')}</tr>`;
        tbody.innerHTML = '';

        periodRows.forEach(w => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${w.ward || w.Ward_Name}</td>
                <td>${w.block || w.Block || '-'}</td>
                <td>${w.capacity || w.sanctioned_beds || 0}</td>
                <td>${w.occ || w.Total_Occupied || 0}</td>
                <td>${w.pw || w.PW_Occupied || 0}</td>
                <td>${w.cw || w.CW_Occupied || 0}</td>
                <td>${w.vacant || w.Vacant_Beds || 0}</td>
                <td>${(w.pct || w.Occupancy_Percentage || 0).toFixed(2)}%</td>
            `;
            tbody.appendChild(tr);
        });
    }
    // Hide the legacy breakdown wrap if it exists
    const breakdownWrap = document.getElementById('report-dept-breakdown');
    if (breakdownWrap) {
        breakdownWrap.style.display = 'none';
    }
}

// ─── Report Logic ────────────────────────────────────────────────────────────
async function loadReportData() {
    if (currentUser?.role !== 'admin' && currentUser?.role !== 'nmc') return;

    // Clear stale state to avoid mixing data between NMC and SJMCH modes
    const tbody = document.querySelector('#ward-table tbody');
    if (tbody) tbody.innerHTML = '';
    const container = document.getElementById('report-chart-container');
    if (container) container.style.display = 'none';
    const statusMsg = document.getElementById('report-status-msg');
    if (statusMsg) statusMsg.textContent = '';

    const startEl = document.getElementById('report-start-date');
    if (startEl && !startEl.value) {
        const today = new Date().toISOString().split('T')[0];
        startEl.value = today;
    }

    // Reset view flag so it doesn't block re-rendering
    reportViewActive = false;

    // Toggle Filter visibility based on Mode
    const endEl = document.getElementById('report-end-date');
    const toLabel = document.querySelector('label[for="report-end-date"]');
    const periodLabel = document.querySelector('label[for="report-period"]');
    const fromLabel = document.querySelector('label[for="report-start-date"]');

    if (endEl) endEl.style.display = 'inline-block';
    if (periodLabel) periodLabel.style.display = 'inline-block';
    if (toLabel) toLabel.style.display = 'inline-block';
    if (fromLabel) fromLabel.textContent = 'From';

    // Wire report controls once
    const applyBtn = document.getElementById('apply-report-btn');
    const startElForWire = document.getElementById('report-start-date');

    if (applyBtn && !applyBtn.dataset.wired) {
        applyBtn.dataset.wired = '1';
        applyBtn.addEventListener('click', () => {
            reportViewActive = true;
            runReport();
        });
    }
    if (startElForWire && !startElForWire.dataset.wired) {
        startElForWire.dataset.wired = '1';
        startElForWire.addEventListener('change', () => {
            reportViewActive = true;
            scheduleRunReport();
        });
    }

    if (reportViewActive) return;

    // Automatically trigger a search to ensure data is fresh for the current mode
    runReport();
}

