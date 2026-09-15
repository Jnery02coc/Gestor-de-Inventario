const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
  body: JSON.stringify(body),
});

const parseBody = (event) => {
  try { return JSON.parse(event.body || "{}"); } catch { return {}; }
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "cache-control": "no-store" }, body: "" };
  }

  const scriptUrl = String(process.env.BODEGA_APPS_SCRIPT_URL || "").trim();
  const token = String(process.env.BODEGA_API_TOKEN || "").trim();
  const configured = !!(scriptUrl && token);
  const q = event.queryStringParameters || {};
  const body = event.httpMethod === "POST" ? parseBody(event) : {};
  const action = String(q.action || body.action || "").trim();

  if (event.httpMethod === "GET" && action === "netlify_health") {
    return json(200, { ok: configured, proxy: true, configured, loginRequired: false, version: "V80.3.5 COMPLETA SIN LOGIN" });
  }

  // Compatibilidad con el frontend anterior: ya no hay sesión ni PIN.
  if (event.httpMethod === "GET" && action === "auth_status") {
    return json(200, { ok: true, authenticated: configured, configured, securityConfigured: false, loginRequired: false, version: "V80.3.5 COMPLETA SIN LOGIN" });
  }
  if (event.httpMethod === "POST" && (action === "login" || action === "logout")) {
    return json(200, { ok: configured, authenticated: configured, loginRequired: false, version: "V80.3.5 COMPLETA SIN LOGIN" });
  }

  if (!configured) {
    return json(503, { ok: false, error: "Faltan BODEGA_APPS_SCRIPT_URL o BODEGA_API_TOKEN en las variables de entorno de Netlify." });
  }

  try {
    if (event.httpMethod === "GET") {
      const u = new URL(scriptUrl);
      Object.entries(q).forEach(([k, v]) => {
        if (v != null && k !== "token" && k !== "callback") u.searchParams.set(k, String(v));
      });
      u.searchParams.set("token", token);
      const response = await fetch(u.toString(), { method: "GET", redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      return { statusCode: response.ok ? 200 : 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: text };
    }

    if (event.httpMethod === "POST") {
      const forwarded = { ...body, token };
      delete forwarded.pin;
      const response = await fetch(scriptUrl, {
        method: "POST", redirect: "follow", headers: { "content-type": "text/plain;charset=utf-8" },
        body: JSON.stringify(forwarded), signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      return { statusCode: response.ok ? 200 : 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: text };
    }

    return json(405, { ok: false, error: "Método no permitido." });
  } catch (err) {
    return json(500, { ok: false, error: String(err?.message || err) });
  }
};
