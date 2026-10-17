# ZeroSight Post-Quantum File Exchange: Minimized UX Architecture

This document builds upon the foundational cryptography established in the `zerosight_ui_architecture_implementation_plan.md` file. It optimizes the user experience (UX) to be remarkably simple, hiding complex cryptographic overhead in the background while emphasizing our two primary selling points: **Quantum Security** and **Mouse-Driven Entropy**.

The goal is a frictionless UI with minimal clicks, zero jargon, and seamless support for large (e.g., 10 GB+) and multiple file uploads.

## Phase 0: Connection Establishment (Host-Controlled Ephemeral Link)

**Objective:** Establish a secure, authenticated tunnel between Sender and Receiver(s) using a strict, host-defined access limit to prevent silent interception.

* **Background:** The Sender (Host) opens the web app, generates a unique room link, and explicitly sets the number of allowed logins (e.g., 1 receiver). The sender then shares this link over another medium (out-of-band communication).

* **Pre-Key Exchange Validation:** When a user clicks the link, the server checks the current login count *before* initiating any ML-KEM public key exchange.

* **Red Alert Security:** If the actual number of logins exceeds the exact limit set by the Host, a "Red Alert" is instantly triggered. The session is immediately destroyed. Both the Sender and the Receiver(s) receive an active system alert warning them of a potential interception, and the Host is prompted to generate a new session.

* **Out-of-Band Authentication:** To guarantee security, the sender must **never** send the file link and the access notification through the same communication channel.

## Phase 1: The Mouse Entropy Generator (Authenticate Level Two)

**Objective:** Generate an unbreakable symmetric encryption key using physical user interactions to maximize mathematical randomness.

* **Background:** Once the initial connection is verified and the participant count is validated, the system initiates "Authenticate Level Two." The browser utilizes its full-screen viewport to capture exactly 120 unique `(clientX, clientY)` coordinates. This massive sample space (guessing 120 specific pixels from millions of available pixels on the screen) makes the resulting 256-bit symmetric key highly resistant to brute-force decryption, completely neutralizing the **"Harvest Now, Decrypt Later"** threat model posed by quantum computers.

* **Sender UI:** A prompt takes over the browser's full screen: *"Drag your mouse randomly across the screen to generate your encryption key."* As the user drags the mouse, a minimal progress bar fills to 100% in milliseconds. No complex jargon—just a simple, engaging action.

## Phase 2: File Selection & Background Quantum Wrapping

**Objective:** Allow user-friendly batch uploading while handling key encapsulation invisibly.

* **Background:** The system uses the receiver's Quantum Public Key to wrap the freshly generated 120-coordinate symmetric key.

* **Sender UI:** A clean drag-and-drop zone appears. The user can drop **multiple files** at once. The UI displays the file names and their individual sizes (e.g., "Project_Data.zip - 10.2 GB", "Assets.folder - 4.1 GB").

## Phase 3: Adaptive Encryption & Upload (Conditional Chunking)

**Objective:** Securely process and upload files of any size, intelligently switching to memory-safe chunking *only* when the file is too large.

* **Background:** The system dynamically evaluates the size of each selected file. 
    * **Standard Files:** If the file size is well within the browser's safe memory limits (e.g., under 500 MB), it reads and encrypts the file rapidly in a single, in-memory pass for maximum speed.
    * **Extremely Large Files:** **Only if the file is extremely large** and exceeds what memory can handle (e.g., a 10 GB file), the system automatically switches to the **Web Streams API (`file.stream()`)**. This pipes the massive data chunk-by-chunk directly through a Web Worker for on-the-fly AES-GCM encryption, keeping RAM usage near zero. It assigns a strictly unique nonce to every single chunk.
* **Sender UI:** The user clicks a single "Secure Send" button. A clean, unified progress bar shows the upload status. The adaptive memory logic and encryption happen entirely off-screen.

## Phase 4: Receiver Decryption (The 10 GB Flow)

**Objective:** Securely decrypt files, mirroring the adaptive logic used during upload.

Once the receiver clicks "Download", the background process executes the optimized sequence:

1. **Receive Key:** Receive the single file key securely (unwrapped using the receiver's local Quantum Private Key).
2. **Adaptive Download & Decrypt:** 
    * If the file was sent standard, download and decrypt the whole file in memory instantly.
    * If the file was chunked due to extreme size, download chunk 0, decrypt it, and **Stream to Disk** (using the File System Access API) to prevent RAM overload. Iterate for all subsequent chunks, reusing the same file key with each chunk's strictly unique nonce.
* **Receiver UI:** A simple "Decrypting & Downloading..." progress bar.

## UX Breakdown: Click & Input Analysis

To ensure maximum conversion and user-friendliness, the friction (clicks and inputs) has been aggressively minimized.

### Sender Flow

**Total Clicks:** 3 | **Total Inputs:** 1 toggle/number field

* **Phase 0 (Room Creation):** 1 click to generate, 1 input to set login limits.

* **Phase 1 (Entropy):** 0 clicks (Requires only random mouse dragging across the browser viewport).

* **Phase 2 (File Selection):** 1 click (Or 1 Drag-and-Drop action) to select multiple files.

* **Phase 3 (Send):** 1 click on the "Secure Send" button.

### Receiver Flow

**Total Clicks:** 2 | **Total Inputs:** 0 text fields

* **Phase 0 (Join):** 1 click to open the shared ephemeral link.

* **Phase 4 (Download):** 1 click on the "Download Files" button.

By pushing the cryptographic heavy lifting (ML-KEM key generation, conditional memory/stream chunking, and the 120-coordinate jitter calculation) into background web workers, the UI remains perfectly clean, highlighting only the engaging security features.