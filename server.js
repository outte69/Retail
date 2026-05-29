const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "database.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Cross@7007";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

const sessions = new Map();

function ensureDatabase() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const adminPassword = hashPassword(DEFAULT_ADMIN_PASSWORD);
    writeDb({
      users: [
        {
          id: crypto.randomUUID(),
          username: "admin",
          role: "admin",
          active: true,
          passwordSalt: adminPassword.salt,
          passwordHash: adminPassword.hash,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      records: {},
      auditLogs: [],
      backups: [],
    });
  }
}

function readDb() {
  ensureDatabase();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const candidate = hashPassword(password, user.passwordSalt).hash;
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
  );
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function currentUser(req) {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const token = bearerToken || parseCookies(req).session;
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  const db = readDb();
  return db.users.find((user) => user.id === session.userId && user.active) || null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function audit(db, req, user, action, details = {}) {
  db.auditLogs.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    userId: user?.id || null,
    username: user?.username || "system",
    action,
    ip: req.socket.remoteAddress,
    details,
  });
  db.auditLogs = db.auditLogs.slice(0, 5000);
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    send(res, 401, { error: "Please sign in again." });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    send(res, 403, { error: "Admin access required." });
    return null;
  }
  return user;
}

function emptyRecord(date) {
  return {
    date,
    updatedAt: null,
    updatedBy: null,
    visitorsJetty: [],
    airportVisitors: [],
    privateBoats: [],
    wristbands: Array.from({ length: 6 }, (_, index) => ({
      id: crypto.randomUUID(),
      category: "",
      color: ["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#9333ea", "#0f766e"][index],
    })),
    cashFloat: {
      openingFloat: 1500,
      cashAdded: 0,
      cashTaken: 0,
      receivedCash: 0,
      actualCash: "",
      notes: "",
    },
    posTransactions: [],
  };
}

function number(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
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

function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function periodForDate(date) {
  return {
    start: `${date} 07:00`,
    end: `${addDays(date, 1)} 06:00`,
  };
}

function movementTotalsWithOpening(rows, opening = 0) {
  const totals = movementTotals(rows);
  return {
    opening,
    arrivals: totals.arrivals,
    departures: totals.departures,
    remaining: opening + totals.arrivals - totals.departures,
  };
}

function openingBalances(db, date) {
  return Object.keys(db.records)
    .filter((recordDate) => recordDate < date)
    .sort()
    .reduce(
      (opening, recordDate) => {
        const record = db.records[recordDate];
        const jetty = movementTotals(record.visitorsJetty || []);
        const airport = movementTotals(record.airportVisitors || []);
        const privateBoats = movementTotals(record.privateBoats || []);
        return {
          jetty: opening.jetty + jetty.arrivals - jetty.departures,
          airport: opening.airport + airport.arrivals - airport.departures,
          privateBoats: opening.privateBoats + privateBoats.arrivals - privateBoats.departures,
        };
      },
      { jetty: 0, airport: 0, privateBoats: 0 }
    );
}

function recordTotals(record, opening = { jetty: 0, airport: 0, privateBoats: 0 }) {
  const jetty = movementTotalsWithOpening(record.visitorsJetty || [], number(opening.jetty));
  const airport = movementTotalsWithOpening(record.airportVisitors || [], number(opening.airport));
  const privateBoats = movementTotalsWithOpening(record.privateBoats || [], number(opening.privateBoats));
  const cash = record.cashFloat || {};
  const cashIncrease = number(cash.cashAdded) + number(cash.receivedCash);
  const expectedCash = number(cash.openingFloat) + cashIncrease;
  const actualCashEntered = cash.actualCash !== "" && cash.actualCash !== null && cash.actualCash !== undefined;
  const cashVariance = actualCashEntered ? number(cash.actualCash) - expectedCash : 0;
  const posTotal = (record.posTransactions || []).reduce(
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

function preserveRowsForNonAdmin(existingRecord, incomingRecord) {
  if (!existingRecord) return incomingRecord;
  ["visitorsJetty", "airportVisitors", "privateBoats"].forEach((section) => {
    const incomingRows = Array.isArray(incomingRecord[section]) ? incomingRecord[section] : [];
    const incomingIds = new Set(incomingRows.map((row) => row.id).filter(Boolean));
    const removedRows = (existingRecord[section] || []).filter((row) => row.id && !incomingIds.has(row.id));
    incomingRecord[section] = [...incomingRows, ...removedRows];
  });
  return incomingRecord;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function recordToCsv(record, opening) {
  const totals = recordTotals(record, opening);
  const period = periodForDate(record.date);
  const rows = [
    ["Retail Monitor"],
    ["Date", record.date],
    ["Operating period", `${period.start} to ${period.end}`],
    ["Updated by", record.updatedBy || ""],
    [],
    ["Visitors Jetty"],
    ["Arrival boat", "Arrived time", "Arrival pax", "Departure boat", "Departure time", "Departure pax"],
    ...(record.visitorsJetty || []).map((row) => [
      row.arrivalBoat,
      row.arrivalTime,
      row.arrivalPax,
      row.departureBoat,
      row.departureTime,
      row.departurePax,
    ]),
    ["Opening balance", "", totals.jetty.opening, "", "", ""],
    ["Total movement", "", totals.jetty.arrivals, "", "", totals.jetty.departures],
    ["Remaining balance", "", totals.jetty.remaining, "", "", ""],
    [],
    ["Visitors Arrived from Airport"],
    ["Arrival flight/boat", "Arrived time", "Arrival pax", "Departure flight/boat", "Departure time", "Departure pax"],
    ...(record.airportVisitors || []).map((row) => [
      row.arrivalBoat,
      row.arrivalTime,
      row.arrivalPax,
      row.departureBoat,
      row.departureTime,
      row.departurePax,
    ]),
    ["Opening balance", "", totals.airport.opening, "", "", ""],
    ["Total movement", "", totals.airport.arrivals, "", "", totals.airport.departures],
    ["Remaining balance", "", totals.airport.remaining, "", "", ""],
    [],
    ["Private Boats"],
    ["Arrival boat", "Arrived time", "Arrival pax", "Departure boat", "Departure time", "Departure pax"],
    ...(record.privateBoats || []).map((row) => [
      row.arrivalBoat,
      row.arrivalTime,
      row.arrivalPax,
      row.departureBoat,
      row.departureTime,
      row.departurePax,
    ]),
    ["Opening balance", "", totals.privateBoats.opening, "", "", ""],
    ["Total movement", "", totals.privateBoats.arrivals, "", "", totals.privateBoats.departures],
    ["Remaining balance", "", totals.privateBoats.remaining, "", "", ""],
    [],
    ["Summary"],
    ["Opening balance", totals.allVisitorsOpening],
    ["Visitors arrived", totals.allVisitorsArrived],
    ["Visitors departed", totals.allVisitorsDeparted],
    ["Visitors remaining on island", totals.allVisitorsRemaining],
    ["Private boat remaining", totals.privateBoats.remaining],
    [],
    ["Wristband Categories"],
    ["Category details", "Color code"],
    ...((record.wristbands || []).map((row) => [row.category, row.color])),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function importRecordFromCsv(date, csv) {
  const record = emptyRecord(date);
  const lines = csv.split(/\r?\n/).filter((line) => line.trim());
  let section = "";
  for (const line of lines) {
    const cells = parseCsvLine(line);
    const first = cells[0];
    if (["Visitors Jetty", "Visitors Arrived from Airport", "Private Boats", "Wristband Categories", "Cash Float", "POS Transactions"].includes(first)) {
      section = first;
      continue;
    }
    if (
      !first ||
      first === "Total" ||
      first === "Arrival boat" ||
      first === "Arrival flight/boat" ||
      first === "Opening float" ||
      first === "Reference" ||
      first === "Category details"
    ) {
      continue;
    }
    if (section === "Visitors Jetty") {
      record.visitorsJetty.push(toMovementRow(cells));
    } else if (section === "Visitors Arrived from Airport") {
      record.airportVisitors.push(toMovementRow(cells));
    } else if (section === "Private Boats") {
      record.privateBoats.push(toMovementRow(cells));
    } else if (section === "Wristband Categories") {
      record.wristbands.push({
        id: crypto.randomUUID(),
        category: cells[0] || "",
        color: cells[1] || "#0f766e",
      });
    } else if (section === "Cash Float") {
      if (cells.length >= 10) {
        record.cashFloat = {
          openingFloat: number(cells[0]),
          cashAdded: number(cells[1]),
          receivedCash: number(cells[2]),
          cashTaken: number(cells[4]),
          actualCash: cells[6] === "" ? "" : number(cells[6]),
          notes: cells[9] || "",
        };
      } else {
        record.cashFloat = {
          openingFloat: number(cells[0]),
          cashAdded: number(cells[1]),
          cashTaken: number(cells[2]),
          receivedCash: number(cells[3]),
          actualCash: cells[5] === "" ? "" : number(cells[5]),
          notes: cells[8] || "",
        };
      }
    } else if (section === "POS Transactions") {
      record.posTransactions.push({
        id: crypto.randomUUID(),
        reference: cells[0] || "",
        description: cells[1] || "",
        cardPos: number(cells[2]),
        bankTransfer: number(cells[3]),
        cash: number(cells[4]),
        refunds: number(cells[5]),
      });
    }
  }
  return record;
}

function toMovementRow(cells) {
  return {
    id: crypto.randomUUID(),
    arrivalBoat: cells[0] || "",
    arrivalTime: cells[1] || "",
    arrivalPax: number(cells[2]),
    departureBoat: cells[3] || "",
    departureTime: cells[4] || "",
    departurePax: number(cells[5]),
  };
}

function createBackup(db, req, user, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `database-${stamp}.json`;
  const target = path.join(BACKUP_DIR, fileName);
  fs.copyFileSync(DB_PATH, target);
  const backup = { id: crypto.randomUUID(), at: new Date().toISOString(), fileName, reason, createdBy: user.username };
  db.backups.unshift(backup);
  audit(db, req, user, "backup-created", { fileName, reason });
  writeDb(db);
  return backup;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(ROOT, requested));
  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}data${path.sep}`)) {
    send(res, 404, "Not found");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const loginName = String(body.username || "").trim().toLowerCase();
    const user = db.users.find((candidate) => candidate.username.toLowerCase() === loginName && candidate.active);
    if (!user || !verifyPassword(body.password || "", user)) {
      audit(db, req, { username: body.username || "unknown" }, "login-failed", {});
      writeDb(db);
      send(res, 401, { error: "Incorrect username or password." });
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
    audit(db, req, user, "login", {});
    writeDb(db);
    send(res, 200, { user: publicUser(user), token }, { "Set-Cookie": `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const user = currentUser(req);
    const authHeader = req.headers.authorization || "";
    const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const token = bearerToken || parseCookies(req).session;
    if (token) sessions.delete(token);
    if (user) {
      audit(db, req, user, "logout", {});
      writeDb(db);
    }
    send(res, 200, { ok: true }, { "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const user = currentUser(req);
    send(res, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/records") {
    const user = requireUser(req, res);
    if (!user) return;
    const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    const record = db.records[date] || emptyRecord(date);
    const opening = openingBalances(db, date);
    send(res, 200, { record, opening, period: periodForDate(date), totals: recordTotals(record, opening) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/records") {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    let record = { ...emptyRecord(body.record?.date), ...body.record };
    if (user.role !== "admin") {
      record = preserveRowsForNonAdmin(db.records[record.date], record);
    }
    record.updatedAt = new Date().toISOString();
    record.updatedBy = user.username;
    db.records[record.date] = record;
    const opening = openingBalances(db, record.date);
    audit(db, req, user, "record-saved", { date: record.date, period: periodForDate(record.date), totals: recordTotals(record, opening) });
    writeDb(db);
    send(res, 200, { record, opening, period: periodForDate(record.date), totals: recordTotals(record, opening) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/records/list") {
    const user = requireUser(req, res);
    if (!user) return;
    const from = url.searchParams.get("from") || "0000-00-00";
    const to = url.searchParams.get("to") || "9999-99-99";
    const records = Object.values(db.records)
      .filter((record) => record.date >= from && record.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((record) => {
        const opening = openingBalances(db, record.date);
        return {
          date: record.date,
          period: periodForDate(record.date),
          updatedAt: record.updatedAt,
          updatedBy: record.updatedBy,
          totals: recordTotals(record, opening),
        };
      });
    send(res, 200, { records });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export") {
    const user = requireUser(req, res);
    if (!user) return;
    const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    const record = db.records[date] || emptyRecord(date);
    audit(db, req, user, "record-exported", { date });
    writeDb(db);
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="retail-monitor-${date}.csv"`,
      "Cache-Control": "no-store",
    });
    res.end(recordToCsv(record, openingBalances(db, date)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const date = body.date || new Date().toISOString().slice(0, 10);
    const record = importRecordFromCsv(date, body.csv || "");
    record.updatedAt = new Date().toISOString();
    record.updatedBy = user.username;
    db.records[date] = record;
    audit(db, req, user, "record-imported", { date });
    writeDb(db);
    const opening = openingBalances(db, date);
    send(res, 200, { record, opening, period: periodForDate(date), totals: recordTotals(record, opening) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    const user = requireAdmin(req, res);
    if (!user) return;
    send(res, 200, { users: db.users.map(publicUser) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const user = requireAdmin(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.username || !body.password) {
      send(res, 400, { error: "Username and password are required." });
      return;
    }
    if (db.users.some((candidate) => candidate.username === body.username)) {
      send(res, 400, { error: "Username already exists." });
      return;
    }
    const password = hashPassword(body.password);
    const newUser = {
      id: crypto.randomUUID(),
      username: body.username,
      role: body.role === "admin" ? "admin" : "user",
      active: true,
      passwordSalt: password.salt,
      passwordHash: password.hash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.users.push(newUser);
    audit(db, req, user, "user-created", { username: newUser.username, role: newUser.role });
    writeDb(db);
    send(res, 200, { users: db.users.map(publicUser) });
    return;
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/users/")) {
    const user = requireAdmin(req, res);
    if (!user) return;
    const userId = url.pathname.split("/").pop();
    const target = db.users.find((candidate) => candidate.id === userId);
    if (!target) {
      send(res, 404, { error: "User not found." });
      return;
    }
    const body = await readBody(req);
    if (body.password) {
      const password = hashPassword(body.password);
      target.passwordSalt = password.salt;
      target.passwordHash = password.hash;
    }
    if (body.role) target.role = body.role === "admin" ? "admin" : "user";
    if (typeof body.active === "boolean") target.active = body.active;
    target.updatedAt = new Date().toISOString();
    audit(db, req, user, "user-updated", { username: target.username, changedPassword: Boolean(body.password) });
    writeDb(db);
    send(res, 200, { users: db.users.map(publicUser) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    const user = requireAdmin(req, res);
    if (!user) return;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const logs = db.auditLogs
      .filter((log) => (!from || log.at.slice(0, 10) >= from) && (!to || log.at.slice(0, 10) <= to))
      .slice(0, 500);
    send(res, 200, { logs });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/backups") {
    const user = requireAdmin(req, res);
    if (!user) return;
    send(res, 200, { backups: db.backups || [] });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/backups") {
    const user = requireAdmin(req, res);
    if (!user) return;
    const backup = createBackup(db, req, user, "manual");
    send(res, 200, { backup, backups: db.backups });
    return;
  }

  send(res, 404, { error: "Not found." });
}

ensureDatabase();

http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      handleApi(req, res).catch((error) => {
        console.error(error);
        send(res, 500, { error: "Server error." });
      });
      return;
    }
    serveStatic(req, res);
  })
  .listen(PORT, HOST, () => {
    console.log(`Retail Monitor running at http://localhost:${PORT}`);
  });
