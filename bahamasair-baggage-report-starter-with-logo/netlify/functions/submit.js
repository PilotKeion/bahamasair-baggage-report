// netlify/functions/submit.js
const sgMail = require("@sendgrid/mail");
const parser = require("aws-lambda-multipart-parser");
const qs = require("querystring");

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    if (!event.body) {
      return { statusCode: 400, body: "No request body found." };
    }

    const headers = event.headers || {};
    const contentType = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
    const isDebug = /\bdebug=1\b/.test(event.rawUrl || "") || /\bdebug=1\b/.test(event.path || "");

    console.log("RequestId:", (context && (context.awsRequestId || context.invocationId)) || "n/a");
    console.log("Content-Type:", contentType, "isBase64:", !!event.isBase64Encoded);

    // ---- helpers
    const norm = (k) => String(k || "").trim().toLowerCase().replace(/[\s\-]+/g, "_");
    const alias = (k) =>
      ({ fullname: "full_name", name: "full_name", passenger_name: "full_name" }[k] || k);
    const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

    // ---- parse body
    let rawFields = {};
    let files = [];

    if (contentType.includes("multipart/form-data")) {
      let parsed = parser.parse(event, true); // buffers
      if (!parsed || Object.keys(parsed).length === 0) parsed = parser.parse(event, false);

      if (!parsed || Object.keys(parsed).length === 0) {
        const len = event.isBase64Encoded ? Buffer.byteLength(event.body, "base64")
                                          : Buffer.byteLength(event.body || "", "utf8");
        return { statusCode: 400, body: `Empty multipart payload (length=${len} bytes).` };
      }
      for (const [key, val] of Object.entries(parsed)) {
        if (val && typeof val === "object" && "filename" in val) {
          files.push({ name: key, ...val });
        } else if (Array.isArray(val)) {
          for (const item of val) {
            if (item && typeof item === "object" && "filename" in item) files.push({ name: key, ...item });
          }
        } else {
          rawFields[key] = String(val ?? "");
        }
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
      rawFields = qs.parse(raw);
    } else {
      return { statusCode: 400, body: `Unsupported Content-Type: ${contentType || "(none)"}.` };
    }

    // ---- normalize keys
    const fields = {};
    for (const [k, v] of Object.entries(rawFields)) fields[alias(norm(k))] = String(v ?? "").trim();
    const receivedKeys = Object.keys(fields).sort();
    console.log("Received field keys (normalized):", receivedKeys);

    if (isDebug) {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentType, isBase64: !!event.isBase64Encoded, receivedKeys }, null, 2),
      };
    }

    // ---- honeypot
    if (fields.fax && String(fields.fax).trim() !== "") {
      return { statusCode: 400, body: "Invalid submission" };
    }

    // ---- required fields
    const required = ["full_name", "email", "phone", "date", "flight", "station", "incident_type", "damage_desc"];
    for (const r of required) if (!fields[r]) return { statusCode: 400, body: `Missing: ${r}` };

    if (fields.incident_type === "Damaged") {
      for (const r of ["brand_dmg", "age_years", "purchase_price"]) {
        if (!fields[r]) return { statusCode: 400, body: `Missing: ${r}` };
      }
    }

    // ---- generate caseId (✅ this was missing)
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const caseId =
      `BAG-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-` +
      `${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // ---- routing
    const stationCode = String(fields.station || "").toUpperCase().slice(0, 3);
    const toStation = process.env[`TO_${stationCode}`] || process.env.TO_DEFAULT_STATION || "";
    const toList = [process.env.TO_PRIMARY, toStation].filter(Boolean);
    if (toList.length === 0) return { statusCode: 500, body: "No destination inbox configured." };

    // ---- build email HTML
    const rows = Object.entries({ ...fields, case_id: caseId })
      .map(([k, v]) => `<tr><td style="font-weight:600;color:#0f3a6d;padding:8px 10px;">${esc(k)}</td><td style="padding:8px 10px;">${esc(v).replace(/\n/g, "<br>")}</td></tr>`)
      .join("");

    const html = `
      <h2 style="color:#0f3a6d;font-family:sans-serif;margin:0 0 8px;">Bahamasair Baggage Irregularity Report</h2>
      <p style="font-family:sans-serif;margin:0 0 12px;">Case: <b>${caseId}</b></p>
      <table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;border-color:#dbe3ef;">
        ${rows}
      </table>
      <hr style="border:none;border-top:1px solid #dbe3ef;margin:18px 0;">
      <p style="font-size:13px;color:#444;font-family:sans-serif;margin:0;">
        This is an automated message from Bahamasair’s Baggage Reporting System.
      </p>
      <br>
      <p style="font-size:13px;color:#0f3a6d;font-family:sans-serif;margin:0;font-weight:600;">NOTICE TO PASSENGERS:</p>
      <p style="font-size:13px;color:#111;font-family:sans-serif;line-height:1.5;margin:6px 0 0;">
        This is a copy of your report covering the mishandling (delay, pilfered, damage or loss) of your baggage.<br>
        <strong>NOTE:</strong> All damage bag reports will be processed in the order that they are received.
      </p>
      <p style="font-size:13px;color:#c00;font-weight:700;font-family:sans-serif;margin:8px 0 0;">
        ANY CLAIM RECEIVED AFTER 90 DAYS WILL NOT BE HONORED.
      </p>
    `;

    // ---- attachments (max 5 x 10MB)
    const attachments = [];
    for (const f of files) {
      if (!["uploads", "uploads[]"].includes(f.name)) continue;
      const buf = f.content;
      if (!buf || buf.length === 0 || buf.length > 10 * 1024 * 1024) continue;
      attachments.push({
        content: buf.toString("base64"),
        filename: f.filename || "file",
        type: f.contentType || "application/octet-stream",
        disposition: "attachment",
      });
      if (attachments.length >= 5) break;
    }

    // ---- send email
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const msg = {
      to: toList,
      from: { email: process.env.FROM_ADDRESS, name: process.env.FROM_NAME || "Bahamasair Baggage Reports" },
      subject: `[${stationCode}] ${fields.incident_type} Baggage Report — ${caseId}`,
      html,
      attachments,
      cc: fields.email ? String(fields.email) : undefined,
    };
    await sgMail.send(msg);

    console.log("Sent OK with caseId:", caseId);
    return { statusCode: 200, body: `OK:${caseId}` }; // ✅ includes the id
  } catch (err) {
    console.error("Handler error:", err);
    return { statusCode: 500, body: `Server error: ${err && err.message ? err.message : String(err)}` };
  }
};
