const TOKEN_KEY = "retail-monitor-session-token";
const today = operatingDate();

let currentUser = null;
let record = emptyRecord(today);
let autoSaveTimer = null;
const editableRows = new Set();
let opening = { jetty: 0, airport: 0, privateBoats: 0 };
let period = periodForDate(today);

const movementColumns = [
  ["arrivalBoat", "Arrival boat", "text"],
  ["arrivalTime", "Arrived time", "time"],
  ["arrivalPax", "No. of pax", "number"],
  ["departureBoat", "Departure boat", "text"],
  ["departureTime", "Departure time", "time"],
  ["departurePax", "No. of pax", "number"],
  ["remarks", "Remarks", "text"],
];

const posColumns = [
  ["reference", "Reference", "text"],
  ["description", "Description", "text"],
  ["cardPos", "Card / POS", "money"],
  ["bankTransfer", "Bank transfer", "money"],
  ["cash", "Cash", "money"],
  ["refunds", "Refunds", "money"],
];

const money = (value) =>
  `MVR ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number(value))}`;
const whole = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number(value));
const number = (value) => {
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function operatingDate(now = new Date()) {
  const start = new Date(now);
  if (start.getHours() < 7) start.setDate(start.getDate() - 1);
  return formatDate(start);
}

function periodForDate(date) {
  return {
    start: `${date} 07:00`,
    end: `${addDays(date, 1)} 06:00`,
  };
}

function emptyMovementRow() {
  return {
    id: crypto.randomUUID(),
    arrivalBoat: "",
    arrivalTime: "",
    arrivalPax: 0,
    departureBoat: "",
    departureTime: "",
    departurePax: 0,
    remarks: "",
  };
}

function emptyWristbandRow(index = 0) {
  const colors = ["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#9333ea", "#0f766e"];
  return {
    id: crypto.randomUUID(),
    category: "",
    color: colors[index % colors.length],
  };
}

function emptyPosRow() {
  return {
    id: crypto.randomUUID(),
    reference: "",
    description: "",
    cardPos: 0,
    bankTransfer: 0,
    cash: 0,
    refunds: 0,
  };
}

function emptyRecord(date) {
  return {
    date,
    visitorsJetty: [emptyMovementRow(), emptyMovementRow()],
    airportVisitors: [emptyMovementRow(), emptyMovementRow()],
    privateBoats: [emptyMovementRow()],
    wristbands: Array.from({ length: 6 }, (_, index) => emptyWristbandRow(index)),
    cashFloat: {
      openingFloat: 1500,
      cashAdded: 0,
      cashTaken: 0,
      receivedCash: 0,
      actualCash: "",
      notes: "",
    },
    posTransactions: [emptyPosRow()],
  };
}

async function api(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed." }));
    throw new Error(error.error || "Request failed.");
  }
  return response.json();
}

function show(view) {
  document.querySelector("#loginView").classList.toggle("hidden", view !== "login");
  document.querySelector("#appView").classList.toggle("hidden", view !== "app");
}

async function boot() {
  const session = await api("/api/session");
  if (!session.user) {
    show("login");
    return;
  }
  currentUser = session.user;
  show("app");
  configureForUser();
  document.querySelector("#recordDate").value = today;
  document.querySelector("#historyFrom").value = today.slice(0, 8) + "01";
  document.querySelector("#historyTo").value = today;
  document.querySelector("#reportFrom").value = today.slice(0, 8) + "01";
  document.querySelector("#reportTo").value = today;
  await loadRecord(today);
}

function configureForUser() {
  document.querySelector("#currentUser").textContent = `${currentUser.username} (${currentUser.role})`;
  document.querySelectorAll(".admin-only").forEach((element) => {
    element.classList.toggle("hidden", currentUser.role !== "admin");
  });
  if (currentUser.role !== "admin" && ["admin", "audit"].includes(document.querySelector(".tab.active")?.dataset.tab)) {
    activateTab("dashboard");
  }
}

function activateTab(tabName) {
  document.querySelectorAll(".tab, .tab-panel").forEach((element) => element.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.classList.add("active");
  document.querySelector(`#${tabName}`)?.classList.add("active");
}

async function loadRecord(date) {
  clearTimeout(autoSaveTimer);
  const result = await api(`/api/records?date=${encodeURIComponent(date)}`);
  record = normalizeRecord(result.record);
  opening = result.opening || { jetty: 0, airport: 0, privateBoats: 0 };
  period = result.period || periodForDate(record.date);
  editableRows.clear();
  document.querySelector("#recordDate").value = record.date;
  renderEntryTables();
  renderDashboardWristbands();
  renderTotals(result.totals || calculateTotals());
  renderDashboardStatus(result.totals || calculateTotals());
  document.querySelector("#saveMessage").textContent = record.updatedAt
    ? `Loaded ${record.date}. Period ${period.start} to ${period.end}. Last saved by ${record.updatedBy || "unknown"}.`
    : `Loaded blank sheet for ${record.date}. Period ${period.start} to ${period.end}.`;
}

function displayDate(date) {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

function monthRange(month) {
  const [year, value] = month.split("-").map(Number);
  const first = `${month}-01`;
  const lastDay = new Date(Date.UTC(year, value, 0)).getUTCDate();
  return { from: first, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function normalizeRecord(source) {
  const normalized = { ...emptyRecord(source.date || today), ...source };
  normalized.visitorsJetty = ensureRows(normalized.visitorsJetty, 2, emptyMovementRow);
  normalized.airportVisitors = ensureRows(normalized.airportVisitors, 2, emptyMovementRow);
  normalized.privateBoats = ensureRows(normalized.privateBoats, 1, emptyMovementRow);
  normalized.wristbands = ensureRows(normalized.wristbands, 6, () => emptyWristbandRow(normalized.wristbands?.length || 0));
  normalized.posTransactions = ensureRows(normalized.posTransactions, 1, emptyPosRow);
  normalized.cashFloat = { ...emptyRecord(normalized.date).cashFloat, ...(normalized.cashFloat || {}) };
  return normalized;
}

function ensureRows(rows, minimum, factory) {
  const next = (rows || []).map((row) => ({ id: row.id || crypto.randomUUID(), ...row }));
  while (next.length < minimum) next.push(factory());
  return next;
}

function movementTotals(rows) {
  return rows.reduce(
    (total, row) => {
      total.arrivals += number(row.arrivalPax);
      total.departures += number(row.departurePax);
      total.remaining += number(row.arrivalPax) - number(row.departurePax);
      return total;
    },
    { arrivals: 0, departures: 0, remaining: 0 }
  );
}

function movementTotalsWithOpening(rows, openingBalance = 0) {
  const totals = movementTotals(rows);
  return {
    opening: openingBalance,
    arrivals: totals.arrivals,
    departures: totals.departures,
    remaining: openingBalance + totals.arrivals - totals.departures,
  };
}

function calculateTotals() {
  const jetty = movementTotalsWithOpening(record.visitorsJetty, number(opening.jetty));
  const airport = movementTotalsWithOpening(record.airportVisitors, number(opening.airport));
  const privateBoats = movementTotalsWithOpening(record.privateBoats, number(opening.privateBoats));
  const cash = record.cashFloat;
  const cashIncrease = number(cash.cashAdded) + number(cash.receivedCash);
  const expectedCash = number(cash.openingFloat) + cashIncrease;
  const actualCashEntered = cash.actualCash !== "" && cash.actualCash !== null && cash.actualCash !== undefined;
  const cashVariance = actualCashEntered ? number(cash.actualCash) - expectedCash : 0;
  const posTotal = record.posTransactions.reduce(
    (total, row) => total + number(row.cardPos) + number(row.bankTransfer) + number(row.cash) - number(row.refunds),
    0
  );
  return {
    jetty,
    airport,
    privateBoats,
    allVisitorsOpening: jetty.opening + airport.opening + privateBoats.opening,
    allVisitorsArrived: jetty.arrivals + airport.arrivals + privateBoats.arrivals,
    allVisitorsDeparted: jetty.departures + airport.departures + privateBoats.departures,
    allVisitorsRemaining: jetty.remaining + airport.remaining + privateBoats.remaining,
    cashIncrease,
    expectedCash,
    cashVariance,
    cashShortage: cashVariance < 0 ? Math.abs(cashVariance) : 0,
    cashExcess: cashVariance > 0 ? cashVariance : 0,
    posTotal,
  };
}

function renderEntryTables() {
  renderMovementTable("visitorsJetty");
  renderMovementTable("airportVisitors");
  renderMovementTable("privateBoats");
  renderWristbandTable();
  renderDashboardWristbands();
}

function renderDashboardWristbands() {
  const target = document.querySelector("#dashboardWristbands");
  if (!target) return;
  const rows = (record.wristbands || []).filter((row) => row.category || row.color);
  target.innerHTML =
    rows
      .map(
        (row, index) => `<article>
          <span class="color-swatch" style="background:${row.color || "#0f766e"}"></span>
          <div>
            <strong>${row.category || `Category ${index + 1}`}</strong>
            <p>${row.color || "#0f766e"}</p>
          </div>
        </article>`
      )
      .join("") || '<p class="empty-state">No wristband categories saved for this duty date.</p>';
}

function renderMovementTable(key) {
  const table = document.querySelector(`[data-table="${key}"]`);
  table.innerHTML = `
    <thead>
      <tr><th>#</th>${movementColumns.map(([, label]) => `<th>${label}</th>`).join("")}<th>Action</th></tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  record[key].forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${index + 1}</td>`;
    movementColumns.forEach(([field, , type]) => tr.append(inputCell(key, index, field, type)));
    tr.append(actionCell(key, index));
    tbody.append(tr);
  });
}

function inputCell(section, index, field, type) {
  const cell = document.createElement("td");
  const input = document.createElement("input");
  input.value = record[section][index][field] ?? "";
  input.type = "text";
  input.inputMode = type === "number" || type === "money" ? "decimal" : "text";
  input.dataset.kind = type;
  input.dataset.section = section;
  input.dataset.index = index;
  input.dataset.field = field;
  input.disabled = shouldLockInput(section, index, field);
  if (field.includes("Boat") || field === "description" || field === "remarks") input.classList.add("wide-input");
  input.addEventListener("input", updateEntry);
  cell.append(input);
  return cell;
}

function rowKey(section, index) {
  return `${section}:${index}`;
}

function hasValue(value) {
  return value !== "" && value !== null && value !== undefined && !(typeof value === "number" && value === 0);
}

function shouldLockInput(section, index, field) {
  return hasValue(record[section][index][field]) && !editableRows.has(rowKey(section, index));
}

function actionCell(section, index) {
  const cell = document.createElement("td");
  const editButton = document.createElement("button");
  const editing = editableRows.has(rowKey(section, index));
  editButton.className = editing ? "done-row" : "edit-row";
  editButton.type = "button";
  editButton.textContent = editing ? "Done" : "Edit";
  editButton.title = editing ? "Save and lock this row" : "Unlock this row for editing";
  editButton.addEventListener("click", async () => {
    if (editing) {
      editableRows.delete(rowKey(section, index));
      await saveRecord({ silent: true });
    } else {
      editableRows.add(rowKey(section, index));
      renderEntryTables();
    }
  });

  cell.className = "row-actions";
  cell.append(editButton);
  if (currentUser?.role === "admin") {
    const button = document.createElement("button");
    button.className = "delete-row";
    button.type = "button";
    button.textContent = "x";
    button.title = "Delete row";
    button.addEventListener("click", () => {
      record[section].splice(index, 1);
      editableRows.delete(rowKey(section, index));
      if (!record[section].length) record[section].push(emptyMovementRow());
      renderEntryTables();
      renderTotals(calculateTotals());
      scheduleAutoSave();
    });
    cell.append(button);
  }
  return cell;
}

function renderWristbandTable() {
  const table = document.querySelector("#wristbandTable");
  table.innerHTML = `
    <thead>
      <tr><th>#</th><th>Category details</th><th>Wristband color</th><th>Color code</th><th>Preview</th><th>Action</th></tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  record.wristbands.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${index + 1}</td>`;
    const categoryCell = document.createElement("td");
    const categoryInput = document.createElement("input");
    categoryInput.className = "wide-input";
    categoryInput.value = row.category || "";
    categoryInput.placeholder = "Category details";
    categoryInput.dataset.wristbandIndex = index;
    categoryInput.dataset.wristbandField = "category";
    categoryInput.addEventListener("input", updateWristband);
    categoryCell.append(categoryInput);

    const colorCell = document.createElement("td");
    const colorInput = document.createElement("input");
    colorInput.className = "color-picker";
    colorInput.type = "color";
    colorInput.value = row.color || "#0f766e";
    colorInput.dataset.wristbandIndex = index;
    colorInput.dataset.wristbandField = "color";
    colorInput.addEventListener("input", updateWristband);
    colorCell.append(colorInput);

    const codeCell = document.createElement("td");
    codeCell.textContent = row.color || "#0f766e";

    const previewCell = document.createElement("td");
    previewCell.innerHTML = `<span class="color-swatch" style="background:${row.color || "#0f766e"}"></span>`;

    const action = document.createElement("td");
    const button = document.createElement("button");
    button.className = "delete-row";
    button.type = "button";
    button.textContent = "x";
    button.title = "Delete category";
    button.addEventListener("click", () => {
      record.wristbands.splice(index, 1);
      if (!record.wristbands.length) record.wristbands.push(emptyWristbandRow());
      renderWristbandTable();
      scheduleAutoSave();
    });
    action.append(button);

    tr.append(categoryCell, colorCell, codeCell, previewCell, action);
    tbody.append(tr);
  });
}

function updateWristband(event) {
  const { wristbandIndex, wristbandField } = event.target.dataset;
  record.wristbands[wristbandIndex][wristbandField] = event.target.value;
  if (wristbandField === "color") {
    const row = event.target.closest("tr");
    row.children[3].textContent = event.target.value;
    row.querySelector(".color-swatch").style.background = event.target.value;
  }
  renderDashboardWristbands();
  scheduleAutoSave();
}

function updateEntry(event) {
  const { section, index, field } = event.target.dataset;
  const isNumber = event.target.dataset.kind === "number" || event.target.dataset.kind === "money";
  record[section][index][field] = isNumber ? number(event.target.value) : event.target.value;
  renderTotals(calculateTotals());
  clearTimeout(autoSaveTimer);
  scheduleAutoSave();
}

function renderTotals(totals) {
  document.querySelector("#periodLabel").textContent = `Period: ${period.start} to ${period.end}`;
  document.querySelector("#workingDateLabel").textContent = displayDate(record.date);
  document.querySelectorAll("[data-duty-date-label]").forEach((element) => {
    element.textContent = displayDate(record.date);
  });
  document.querySelector("#jettyArrived").textContent = whole(totals.jetty.arrivals);
  document.querySelector("#jettyDeparted").textContent = whole(totals.jetty.departures);
  document.querySelector("#jettyRemaining").textContent = whole(totals.jetty.remaining);
  document.querySelector("#airportArrived").textContent = whole(totals.airport.arrivals);
  document.querySelector("#airportDeparted").textContent = whole(totals.airport.departures);
  document.querySelector("#airportRemaining").textContent = whole(totals.airport.remaining);
  document.querySelector("#allVisitorsArrivedDetail").textContent = whole(totals.allVisitorsArrived);
  document.querySelector("#allVisitorsDepartedDetail").textContent = whole(totals.allVisitorsDeparted);
  document.querySelector("#allVisitorsRemainingDetail").textContent = whole(totals.allVisitorsRemaining);
  document.querySelector("#privateArrived").textContent = whole(totals.privateBoats.arrivals);
  document.querySelector("#privateDeparted").textContent = whole(totals.privateBoats.departures);
  document.querySelector("#privateRemainingDetail").textContent = whole(totals.privateBoats.remaining);
}

function renderDashboardStatus(totals) {
  if (document.querySelector("#currentStatusText")) {
    document.querySelector("#currentStatusText").textContent =
    record.date === today
      ? `Current duty date ${displayDate(today)} has ${whole(totals.allVisitorsRemaining)} visitors remaining.`
      : `Current duty date is ${displayDate(today)}.`;
  }
  if (document.querySelector("#selectedStatusText")) {
    document.querySelector("#selectedStatusText").textContent =
      `Selected duty date ${displayDate(record.date)} runs ${period.start} to ${period.end}.`;
  }
  if (document.querySelector("#reportStatusText")) {
    document.querySelector("#reportStatusText").textContent =
      `${whole(totals.allVisitorsArrived)} arrivals, ${whole(totals.allVisitorsDeparted)} departures, ${whole(totals.allVisitorsRemaining)} remaining.`;
  }
}

function setMoney(selector, value, status = "auto") {
  const element = document.querySelector(selector);
  element.textContent = money(value);
  element.classList.toggle("negative", status === "negative" ? value > 0 : value < 0);
  element.classList.toggle("positive", status === "positive" ? value > 0 : status === "auto" && value > 0);
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  document.querySelector("#saveMessage").textContent = "Saving...";
  autoSaveTimer = setTimeout(() => saveRecord({ silent: true, keepEditing: true }), 1000);
}

async function saveRecord(options = {}) {
  record.date = document.querySelector("#recordDate").value;
  const result = await api("/api/records", { method: "POST", body: JSON.stringify({ record }) });
  record = normalizeRecord(result.record);
  opening = result.opening || opening;
  period = result.period || periodForDate(record.date);
  if (!options.keepEditing) editableRows.clear();
  renderEntryTables();
  renderDashboardWristbands();
  renderTotals(result.totals);
  renderDashboardStatus(result.totals);
  document.querySelector("#saveMessage").textContent = options.silent ? `Saved automatically at ${new Date().toLocaleTimeString()}.` : `Saved ${record.date}.`;
}

async function loadHistory() {
  const month = document.querySelector("#historyMonth").value;
  const range = month ? monthRange(month) : null;
  const from = range?.from || document.querySelector("#historyFrom").value;
  const to = range?.to || document.querySelector("#historyTo").value;
  const result = await api(`/api/records/list?from=${from}&to=${to}`);
  const rows = result.records
    .map(
      (item) => `<tr data-history-date="${item.date}">
        <td>${item.date}</td>
        <td>${item.period?.start || ""} to ${item.period?.end || ""}</td>
        <td>${item.updatedBy || ""}</td>
        <td>${item.updatedAt ? new Date(item.updatedAt).toLocaleString() : ""}</td>
        <td>${whole(item.totals.allVisitorsArrived)}</td>
        <td>${whole(item.totals.allVisitorsDeparted)}</td>
        <td>${whole(item.totals.allVisitorsRemaining)}</td>
        <td>${whole(item.totals.privateBoats.arrivals)}</td>
        <td>${whole(item.totals.privateBoats.departures)}</td>
        <td>${whole(item.totals.privateBoats.remaining)}</td>
      </tr>`
    )
    .join("");
  document.querySelector("#historyTable").innerHTML = `
    <thead><tr><th>Date</th><th>Period</th><th>Updated by</th><th>Saved at</th><th>Visitors arrived</th><th>Visitors departed</th><th>Visitors remaining</th><th>Private arrived</th><th>Private departed</th><th>Private remaining</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="10">No records found.</td></tr>'}</tbody>
  `;
}

function reportTotals(records) {
  const movement = records.reduce(
    (totals, item) => {
      totals.arrivals += number(item.totals.allVisitorsArrived);
      totals.departures += number(item.totals.allVisitorsDeparted);
      return totals;
    },
    { arrivals: 0, departures: 0, remaining: 0, privateRemaining: 0 }
  );
  const closingRecord = records[0];
  movement.remaining = closingRecord ? number(closingRecord.totals.allVisitorsRemaining) : 0;
  movement.privateRemaining = closingRecord ? number(closingRecord.totals.privateBoats.remaining) : 0;
  return movement;
}

async function loadReport() {
  const month = document.querySelector("#reportMonth").value;
  const range = month ? monthRange(month) : null;
  const from = range?.from || document.querySelector("#reportFrom").value;
  const to = range?.to || document.querySelector("#reportTo").value;
  const result = await api(`/api/records/list?from=${from}&to=${to}`);
  const totals = reportTotals(result.records);
  document.querySelector("#reportArrivals").textContent = whole(totals.arrivals);
  document.querySelector("#reportDepartures").textContent = whole(totals.departures);
  document.querySelector("#reportRemaining").textContent = whole(totals.remaining);
  document.querySelector("#reportPrivateRemaining").textContent = whole(totals.privateRemaining);
  document.querySelector("#reportTable").innerHTML = `
    <thead><tr><th>Date</th><th>Period</th><th>Updated by</th><th>Visitors arrived</th><th>Visitors departed</th><th>Visitors remaining</th><th>Private arrived</th><th>Private departed</th><th>Private remaining</th></tr></thead>
    <tbody>
      ${
        result.records
          .map(
            (item) => `<tr data-history-date="${item.date}">
              <td>${item.date}</td>
              <td>${item.period?.start || ""} to ${item.period?.end || ""}</td>
              <td>${item.updatedBy || ""}</td>
              <td>${whole(item.totals.allVisitorsArrived)}</td>
              <td>${whole(item.totals.allVisitorsDeparted)}</td>
              <td>${whole(item.totals.allVisitorsRemaining)}</td>
              <td>${whole(item.totals.privateBoats.arrivals)}</td>
              <td>${whole(item.totals.privateBoats.departures)}</td>
              <td>${whole(item.totals.privateBoats.remaining)}</td>
            </tr>`
          )
          .join("") || '<tr><td colspan="9">No records found.</td></tr>'
      }
    </tbody>
  `;
}

async function loadUsers() {
  if (currentUser.role !== "admin") return;
  const result = await api("/api/users");
  document.querySelector("#usersTable").innerHTML = `
    <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>New password</th><th>Action</th></tr></thead>
    <tbody>
      ${result.users
        .map(
          (user) => `<tr>
            <td>${user.username}</td>
            <td>
              <select data-user-role="${user.id}">
                <option value="user" ${user.role === "user" ? "selected" : ""}>User</option>
                <option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option>
              </select>
            </td>
            <td>
              <select data-user-active="${user.id}">
                <option value="true" ${user.active ? "selected" : ""}>Active</option>
                <option value="false" ${!user.active ? "selected" : ""}>Disabled</option>
              </select>
            </td>
            <td><input data-user-password="${user.id}" type="password" placeholder="Leave blank to keep" /></td>
            <td><button data-save-user="${user.id}" type="button">Save</button></td>
          </tr>`
        )
        .join("")}
    </tbody>
  `;
}

async function updateUser(userId) {
  const role = document.querySelector(`[data-user-role="${userId}"]`).value;
  const active = document.querySelector(`[data-user-active="${userId}"]`).value === "true";
  const password = document.querySelector(`[data-user-password="${userId}"]`).value;
  await api(`/api/users/${userId}`, { method: "PATCH", body: JSON.stringify({ role, active, password }) });
  document.querySelector("#adminMessage").textContent = "User updated.";
  await loadUsers();
}

async function loadAudit() {
  if (currentUser.role !== "admin") return;
  const month = document.querySelector("#auditMonth").value;
  const range = month ? monthRange(month) : null;
  const params = new URLSearchParams();
  if (range) {
    params.set("from", `${range.from}T00:00`);
    params.set("to", `${range.to}T23:59`);
  } else {
    if (document.querySelector("#auditFrom").value) params.set("from", document.querySelector("#auditFrom").value);
    if (document.querySelector("#auditTo").value) params.set("to", document.querySelector("#auditTo").value);
  }
  const result = await api(`/api/audit?${params.toString()}`);
  document.querySelector("#auditTable").innerHTML = `
    <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
    <tbody>
      ${
        result.logs
          .map(
            (log) => `<tr>
              <td>${new Date(log.at).toLocaleString()}</td>
              <td>${log.username}</td>
              <td>${log.action}</td>
              <td>${JSON.stringify(log.details || {})}</td>
            </tr>`
          )
          .join("") || '<tr><td colspan="4">No audit logs yet.</td></tr>'
      }
    </tbody>
  `;
}

async function loadBackups() {
  if (currentUser.role !== "admin") return;
  const result = await api("/api/backups");
  document.querySelector("#backupTable").innerHTML = `
    <thead><tr><th>Created</th><th>By</th><th>File</th></tr></thead>
    <tbody>
      ${
        result.backups
          .map((backup) => `<tr><td>${new Date(backup.at).toLocaleString()}</td><td>${backup.createdBy}</td><td>${backup.fileName}</td></tr>`)
          .join("") || '<tr><td colspan="3">No backups yet.</td></tr>'
      }
    </tbody>
  `;
}

async function importCsv(file) {
  const csv = await file.text();
  const date = document.querySelector("#recordDate").value;
  const result = await api("/api/import", { method: "POST", body: JSON.stringify({ date, csv }) });
  record = normalizeRecord(result.record);
  opening = result.opening || opening;
  period = result.period || periodForDate(record.date);
  renderEntryTables();
  renderTotals(result.totals);
  document.querySelector("#saveMessage").textContent = `Imported CSV into ${date}.`;
}

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.querySelector("#loginUsername").value.trim(),
        password: document.querySelector("#loginPassword").value,
      }),
    });
    if (result.token) localStorage.setItem(TOKEN_KEY, result.token);
    currentUser = result.user;
    show("app");
    configureForUser();
    document.querySelector("#recordDate").value = today;
    document.querySelector("#historyFrom").value = today.slice(0, 8) + "01";
    document.querySelector("#historyTo").value = today;
    document.querySelector("#reportFrom").value = today.slice(0, 8) + "01";
    document.querySelector("#reportTo").value = today;
    await loadRecord(today);
  } catch (error) {
    document.querySelector("#loginMessage").textContent = error.message;
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  localStorage.removeItem(TOKEN_KEY);
  show("login");
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    if (currentUser?.role !== "admin" && tab.classList.contains("admin-only")) return;
    activateTab(tab.dataset.tab);
    if (tab.dataset.tab === "records") await loadHistory();
    if (tab.dataset.tab === "reports") await loadReport();
    if (tab.dataset.tab === "admin") await loadUsers();
    if (tab.dataset.tab === "audit") {
      await loadAudit();
      await loadBackups();
    }
  });
});

document.querySelector("#loadRecord").addEventListener("click", () => loadRecord(document.querySelector("#recordDate").value));
document.querySelector("#recordDate").addEventListener("change", (event) => loadRecord(event.target.value));
document.querySelector("#saveRecord").addEventListener("click", saveRecord);
document.querySelector("#exportRecord").addEventListener("click", () => {
  window.location.href = `/api/export?date=${encodeURIComponent(document.querySelector("#recordDate").value)}`;
});
document.querySelector("#importCsv").addEventListener("change", (event) => {
  if (event.target.files[0]) importCsv(event.target.files[0]);
});
document.querySelector("#loadHistory").addEventListener("click", loadHistory);
document.querySelector("#historyTable").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-history-date]");
  if (!row) return;
  activateTab("dataEntry");
  await loadRecord(row.dataset.historyDate);
});
document.querySelector("#loadReport").addEventListener("click", loadReport);
document.querySelector("#exportReportRecord").addEventListener("click", () => {
  window.location.href = `/api/export?date=${encodeURIComponent(document.querySelector("#recordDate").value)}`;
});
document.querySelector("#reportTable").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-history-date]");
  if (!row) return;
  await loadRecord(row.dataset.historyDate);
  activateTab("dashboard");
});
document.querySelectorAll("[data-entry-target]").forEach((card) => {
  card.addEventListener("click", () => activateTab(card.dataset.entryTarget));
});
document.querySelectorAll("[data-add-row]").forEach((button) => {
  button.addEventListener("click", () => {
    const section = button.dataset.addRow;
    record[section].push(emptyMovementRow());
    renderEntryTables();
    renderTotals(calculateTotals());
  });
});
document.querySelector("#addWristbandRow").addEventListener("click", () => {
  record.wristbands.push(emptyWristbandRow(record.wristbands.length));
  renderWristbandTable();
  scheduleAutoSave();
});

document.querySelector("#createUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username: document.querySelector("#newUsername").value.trim(),
      password: document.querySelector("#newPassword").value,
      role: document.querySelector("#newRole").value,
    }),
  });
  event.target.reset();
  document.querySelector("#adminMessage").textContent = "User created.";
  await loadUsers();
});
document.querySelector("#usersTable").addEventListener("click", (event) => {
  const userId = event.target.dataset.saveUser;
  if (userId) updateUser(userId);
});
document.querySelector("#loadAudit").addEventListener("click", loadAudit);
document.querySelector("#createBackup").addEventListener("click", async () => {
  await api("/api/backups", { method: "POST" });
  await loadBackups();
  await loadAudit();
});

boot().catch((error) => {
  show("login");
  document.querySelector("#loginMessage").textContent = error.message;
});
