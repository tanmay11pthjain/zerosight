# ZeroSight

Send files nobody else can open. Files are encrypted on the sender's device with post-quantum key exchange (ML-KEM-768) and AES-256-GCM, stored in S3 as unreadable `.enc` parts, and deleted the moment the receiver has them. If the link is opened by more people than the sender allowed, a **Red Alert** destroys everything instantly.

**Why people use it:** email attachments live forever and links get forwarded. With ZeroSight the server can't read your files, you know if anyone else opened the link, and the files are gone after delivery, with a signed deletion receipt. The receiver needs no account and no app.

- Sender: drop files or a folder into the 0 → **Send securely** → move the mouse (120 points + CPU timing make the key) → share the link or QR code. Keep the page open until the receiver opens it.
- Receiver: open the link → **Receive files** → **Save** (several files arrive as one .zip).

## Layout

| Path | What | Deploys to |
|---|---|---|
| `web/` | Vite + TypeScript app (sender + receiver, one look), crypto, upload/download engines | Vercel |
| `api/` | Fastify API: rooms, login counting + Red Alert, key relay, presigned S3 URLs, burn + receipts, sweeper | Render |
| `infra/` | S3 CORS, lifecycle and IAM policy JSON | AWS |
| `render.yaml` | Render Blueprint (API + free Postgres) | Render |
| `legacy/` | the earlier in-memory prototype (safe to delete) | none |

## Live demo on two devices (no accounts)

```bash
npm run install:all   # once
npm run demo          # builds, starts the server, prints a public https link and opens it
```

Open the printed `https://….trycloudflare.com` link on the laptop, add files or a folder, press **Send securely**, move the mouse, then scan the QR code with the phone and press **Receive files** → **Save**. Both screens end on "Delivered, then deleted." A third device opening the same link gets the Red Alert.

Rules (fixed, no settings): one recipient, one download. The sender only picks the delete timer: 15 min, 1 hour or 24 hours.

## Deploy (Render, free, one service)

1. Push this repo to GitHub.
2. Render → New → **Blueprint** → pick the repo → Apply. `render.yaml` builds the app and serves app + API from one URL.
3. Optional: set `RECEIPT_SIGNING_KEY` so receipts stay verifiable across restarts:
   ```bash
   node -e "const {privateKey}=require('crypto').generateKeyPairSync('ed25519');console.log(Buffer.from(privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))"
   ```

Free instances sleep after 15 idle minutes (the app shows "Waking up the server…") and keep files in memory, so transfers are capped at 150 MB there. For bigger files, set `STORAGE_TYPE=s3` with the AWS variables in `api/.env.example` and `infra/`.

## Develop and test

```bash
npm run dev          # API :8787 + Vite :5173 with hot reload
npm test             # 25 tests: crypto, full protocol, Red Alert race, limits, sweeper
npm run typecheck
```

## Security model (short)

- File key = SHA-256(120 mouse points + CPU timing) XOR the browser's secure random generator.
- Each file gets its own key (HKDF); every part is AES-256-GCM with its position bound in, so parts can't be swapped, dropped or altered.
- The receiver's browser makes an ML-KEM-768 key pair. The sender locks the file key with it **and** with a 256-bit secret that lives only after the `#` in the link (never sent to any server). A server that swapped in its own key still couldn't open anything.
- Room ids are 64 characters (256 bits). Tokens are stored only as hashes. Files go straight between the browser and S3 through 15-minute presigned URLs bound to exact sizes.
- Login count: joins are counted in one database transaction with a row lock; one extra device triggers the Red Alert. The same browser re-opening the link is not counted. Joining needs the **Receive** click, so link previews and email scanners never count.
- Burn on delivery, timer, Red Alert, sender, or sender leaving before handing over the key; the sweeper retries S3 deletes and the lifecycle rule is the final backstop.

Honest limits: if a stranger opens the link first while the sender is online, they can receive the key; turn on **"Ask me before anyone gets the files"** to approve each device. The deletion receipt proves our copy is gone, not copies a receiver saved. File sizes and timing are visible to the server.
