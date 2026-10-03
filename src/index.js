export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      return verifySubscription(url, env);
    }

    if (request.method === "POST") {
      return receiveEvent(request, env);
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

function verifySubscription(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && challenge && timingSafeEqual(token, env.VERIFY_TOKEN)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

async function receiveEvent(request, env) {
  const rawBody = await request.text();

  if (!env.APP_SECRET) {
    // Fail closed: never accept unverified events. Set it with `wrangler secret put APP_SECRET`.
    console.error("APP_SECRET not set: rejecting webhook event");
    return new Response("Server misconfigured", { status: 500 });
  }

  const signature = request.headers.get("X-Hub-Signature-256") || "";
  const expected = "sha256=" + (await hmacSha256Hex(env.APP_SECRET, rawBody));
  if (!timingSafeEqual(signature, expected)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const message of value.messages || []) {
        console.log("message", JSON.stringify({ from: message.from, type: message.type, id: message.id, text: message.text?.body }));
      }
      for (const status of value.statuses || []) {
        console.log("status", JSON.stringify({ id: status.id, status: status.status, recipient: status.recipient_id }));
      }
    }
  }

  // Meta retries any non-200 response, so acknowledge fast.
  return new Response("EVENT_RECEIVED", { status: 200 });
}

async function hmacSha256Hex(secret, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
