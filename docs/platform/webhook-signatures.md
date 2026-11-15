# Verifying a webhook signature (INT-01, WP-1.18)

A fORM- webhook posts a form response to an address you chose. Anyone who knows that address can post to it too, so every request carries a signature that proves it came from fORM- and was not changed on the way. Check it before you trust the body.

This page is for the person who builds the receiving end. It has the recipe in Node and in Python, and what else to know about a delivery. The Node recipe below is the file `apps/worker/src/effects/webhook/verify-recipe.ts`, quoted whole; a test (`sign.test.ts`) fails if this page and that file differ, and signs with the real code and verifies with the recipe, so what you copy here works against what fORM- sends.

## What a request looks like

```
POST /your/path HTTP/1.1
content-type: application/json
user-agent: fORM-Webhooks/1
fORM-Signature: t=1731744000,v1=5c1e...e0a9
fORM-Delivery-Id: 0193...
fORM-Event: submission.created

{"id":"0193...","event":"submission.created","createdAt":"2026-11-16T08:00:00.000Z","form":{"id":"..."},"submission":{"id":"...","submittedAt":"2026-11-16T07:59:58.000Z","answers":{"full_name":{"first":"Asha"}}}}
```

| Header | Meaning |
|---|---|
| `fORM-Signature` | `t=<unix seconds>,v1=<hex>`: the time the request was signed, and the signature |
| `fORM-Delivery-Id` | The id of this delivery. The same on every retry of it, new for a replay |
| `fORM-Event` | The event, also in the body: `submission.created` or `submission.updated` |

(Node lower-cases header names: read `req.headers['form-signature']`. HTTP header names are case-insensitive.)

## How the signature is made

1. `t` is the time of the attempt in whole seconds since 1970. A retry or a replay signs again, with a new `t`.
2. The signed text is `t`, a dot, and the **raw request body**: `<t>.<body>`.
3. The signature is `HMAC-SHA256(secret, signed text)` as lower-case hex, sent as `v1`.

The **secret** is the signing secret fORM- showed you once, when you made the webhook or rotated its secret. It looks like `whsec_` followed by 43 letters, digits, `-` and `_`. Use it exactly as shown, as text, **with the `whsec_` start**: the whole text is the HMAC key, so do not cut the `whsec_` off and do not base64-decode what follows. fORM- never shows it again; if you lost it, rotate it.

## How to check it

1. Read the **raw body** before anything parses it. Parsing the JSON and printing it again changes spaces and key order, and the signature will not match. With Express use `express.raw({ type: 'application/json' })` on this route, not `express.json()`.
2. Split the `fORM-Signature` header on `,` and read `t` and every `v1`.
3. **Refuse a request whose `t` is more than 5 minutes from your clock**, in either direction. This stops a captured request being sent to you again later.
4. Compute the HMAC of `<t>.<raw body>` with your secret.
5. Compare it with each `v1` **in constant time** (`timingSafeEqual`, `hmac.compare_digest`). An ordinary `==` stops at the first different byte, and the time it takes tells an attacker how many bytes were right.
6. Only then parse the body.

### Node

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A request older or newer than this many seconds is refused, so a captured request cannot be sent again later. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * True when `signatureHeader` (the `fORM-Signature` header) is a valid signature of `rawBody` made with `secret`, and the
 * request is no more than five minutes old.
 *
 * `rawBody` must be the bytes exactly as they arrived, before any JSON parsing: parsing and printing again changes
 * spaces and key order, and the signature no longer matches. `secret` is the signing secret as it was shown to you, with its
 * `whsec_` start (do not decode it, do not cut anything off it).
 */
export function verifyWebhook(rawBody: string | Uint8Array, signatureHeader: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!signatureHeader) return false;

  // The header is `t=<unix seconds>,v1=<hex>`; it may hold several `v1` entries (during a secret change).
  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === 't') timestamp = value;
    if (name === 'v1') candidates.push(value);
  }
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return false;

  // Refuse a request outside the tolerance, in either direction.
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  // The signed text is the timestamp, a dot, and the raw body.
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();

  // Compare in constant time, so the time taken does not tell an attacker how many bytes were right.
  return candidates.some((hex) => /^[0-9a-f]{64}$/i.test(hex) && timingSafeEqual(Buffer.from(hex, 'hex'), expected));
}
```

Using it with Express:

```js
app.post('/hooks/form', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyWebhook(req.body, req.get('fORM-Signature'), process.env.FORM_WEBHOOK_SECRET)) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString('utf8'));
  // ... store event.submission.answers, keyed by event.id or the fORM-Delivery-Id header ...
  res.sendStatus(200);
});
```

### Python

```python
import hashlib
import hmac
import re
import time
from typing import Optional

TOLERANCE_SECONDS = 5 * 60  # refuse a request this much older or newer than your clock


def verify_webhook(raw_body: bytes, signature_header: Optional[str], secret: str, now: Optional[float] = None) -> bool:
    """True when the fORM-Signature header is valid for raw_body and the request is at most five minutes old.

    raw_body is the request body exactly as it arrived (bytes, before any JSON parsing).
    secret is the signing secret as it was shown to you, with its whsec_ start (do not decode it, do not cut anything off it).
    """
    if not signature_header:
        return False

    # The header is "t=<unix seconds>,v1=<hex>"; it may hold several v1 entries (during a secret change).
    timestamp = None
    candidates = []
    for part in signature_header.split(","):
        name, separator, value = part.partition("=")
        if not separator:
            continue
        if name.strip() == "t":
            timestamp = value.strip()
        elif name.strip() == "v1":
            candidates.append(value.strip())
    if timestamp is None or not re.fullmatch(r"[0-9]{1,12}", timestamp):
        return False

    # Refuse a request outside the tolerance, in either direction.
    current = time.time() if now is None else now
    if abs(current - int(timestamp)) > TOLERANCE_SECONDS:
        return False

    # The signed text is the timestamp, a dot, and the raw body.
    signed = timestamp.encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

    # Compare in constant time, so the time taken does not tell an attacker how many characters were right.
    return any(re.fullmatch(r"[0-9a-fA-F]{64}", c) is not None and hmac.compare_digest(c.lower(), expected) for c in candidates)
```

Using it with Flask:

```python
@app.post("/hooks/form")
def form_hook():
    if not verify_webhook(request.get_data(), request.headers.get("fORM-Signature"), os.environ["FORM_WEBHOOK_SECRET"]):
        abort(401)
    event = request.get_json()
    # ... store event["submission"]["answers"], keyed by event["id"] or the fORM-Delivery-Id header ...
    return "", 200
```

## What the body holds

```
{
  "id": "<event id>",
  "event": "submission.created",
  "createdAt": "<ISO instant>",
  "form": { "id": "<form id>" },
  "submission": { "id": "<response id>", "submittedAt": "<ISO instant>", "answers": { "<key>": <value> } }
}
```

- **`id`** names the event. A retry and a replay of the same event carry the same `id` and the same `createdAt`, so you can tell a repeat. `fORM-Delivery-Id` names one delivery.
- **`answers`** has one entry per field this webhook is allowed to receive, named by the field's key (or by its block id, when the webhook is set to name them by id). A field outside the purposes the webhook is declared for is **not there at all**. A field that is withheld (a sensitive field set to be masked) is the text `••••••`. A field that is allowed but was not answered is `null`. The webhook's own field list narrows this further, never widens it.
- A value is typed as the form stores it: a phone is `{ "e164": "+9198...", "country": "IN" }`, a number is a decimal string, a date is `YYYY-MM-DD`. A file is its metadata (`fileId`, `name`, `sizeBytes`, `mime`, `sha256`) with **no URL**: signed file URLs are not sent yet.
- Every delivery adds a line to the disclosures ledger of the response (who received which fields), as the data protection law asks.

## Delivery, retries and what makes a webhook stop

- Answer with **any 2xx** within **30 seconds**. Do the real work after you have stored the event: a slow receiver is a failing receiver. fORM- reads at most 64 KB of your answer, and an answer larger than that counts as a failure.
- **Redirects are not followed.** A `301` or `302` is a failure; give fORM- the final address.
- Anything else (another status, no answer, a timeout) is tried again, up to **3 more times**: the first retry comes about a minute later and each wait is longer than the one before (never more than 24 hours). After the last try the delivery is marked dead. Delivery is **at least once**: the same event can reach you twice (for example when your answer was lost on the way back), so drop a repeat by `fORM-Delivery-Id` or the event `id`.
- A webhook whose address fORM- refuses to call (a private or internal address, a cloud metadata address, a host that this installation does not allow) is dead at once and is not retried.
- After **50 failed attempts in a row** the webhook is **turned off** and the reason is on it. A success starts the count again. Fix the receiver, turn the webhook on, and replay the deliveries you missed from the delivery log.
- On the hosted service the address must be `https`.
- The delivery log keeps the status, the HTTP status, the time it took and a hash of the body for 365 days, and the first 1 KB of your answer, with email addresses and long digit runs removed, for 30 days.
