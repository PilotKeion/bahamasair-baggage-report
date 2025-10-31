const sgMail = require("@sendgrid/mail");
const parser = require("aws-lambda-multipart-parser");
const qs = require("querystring");

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    if (!event.body) return { statusCode: 400, body: "No request body found." };

    const headers = event.headers || {};
    const contentType = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
    const isDebug = /\bdebug=1\b/.test(event.rawUrl || "") || /\bdebug=1\b/.test(event.path || "");

    console.log("RequestId:", (context && (context.awsRequestId || context.invocationId)) || "n/a");
    console.log("Content-Type:", contentType, "isBase64:", !!event.isBase64Encoded);

    const norm = (k) => String(k || "").trim().toLowerCase().replace(/[\s\-]+/g, "_");
    const alias = (k) => ({ fullname:"full_name", name:"full_name", passenger_name:"full_name" }[k] || k);

    let rawFields = {};
    let files = [];

    if (contentType.includes("multipart/form-data")) {
      // Try parser with buffers (recommended)
      let parsed = parser.parse(event, true);
      // Fall back: try without buffers if we got nothing (some envs behave differently)
      if (Object.keys(parsed || {}).length === 0) {
        parsed = parser.parse(event, false);
      }

      // If still nothing, report body length so we can detect truncation/limits
      if (!parsed || Object.keys(parsed).length === 0) {
        const bodyLen = event.isBase64Encoded ? Buffer.byteLength(event.body, "base64") : Buffer.byteLength(event.body || "", "utf8");
        return { statusCode: 400, body: `Empty multipart payload (length=${bodyLen} bytes). If uploading files, keep each under ~5–8MB or try without files to confirm.` };
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

    // Normalize & alias
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

    // REQUIRED
    const required = ["full_name","email","phone","date","flight","station","incident_type","damage_desc"];
    for (const r of required) if (!fields[r]) return { statusCode: 400, body: `Missing: ${r} | Received keys: ${receivedKeys.join(", ")}` };

    if (fields.incident_type === "Damaged") {
      for (const r of ["brand_dmg","age_years","purchase_price"]) if (!fields[r]) return { statusCode: 400, body: `Missing: ${r}` };
    }

    // ... (send email code you already have) ...
    return { statusCode: 200, body: "OK:${caseId}" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Server error: " + (err.message || String(err)) };
  }
};
