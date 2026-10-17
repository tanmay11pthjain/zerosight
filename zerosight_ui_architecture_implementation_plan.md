# Architecture Implementation Plan: ZeroSight Post-Quantum File Exchange

This document outlines the end-to-end technical implementation for a post-quantum, zero-knowledge file sharing platform. This architecture leverages human kinetic noise (mouse movements) and hardware performance micro-jitter to generate mathematically unpredictable encryption keys, ensuring immunity against current and future quantum computing threats. 

Crucially, **every cryptographic phase is visually represented in the UI**, ensuring users experience the security processes in real-time.

---

## Phase 1: Session Initiation & Cryptographic Handshake

**Objective:** Establish a secure, zero-knowledge tunnel and exchange asymmetric keys between Client A (Sender) and Client B (Receiver) without the server ever accessing private keys.

1. **Authentication & Room Creation:**
   * Client A logs into the platform and initiates a new sharing session (a "Room").
   * The server provisions a unique Room ID with pending Time-To-Live (TTL) and download limit parameters.
   * **🖥️ UI Representation:** Client A sees a futuristic "Waiting Room" dashboard with a pulsating status indicator: *"Waiting for Recipient to Join..."*
2. **Post-Quantum Key Pair Generation:**
   * Upon joining the room, Client B's browser generates a Post-Quantum ML-KEM (Module-Lattice-Based Key-Encapsulation Mechanism) Public/Private key pair in local memory.
   * Client B's *Private Key* is securely stored in their browser's `sessionStorage` or an IndexedDB enclave.
   * Client B's *Public Key* is pushed to the server and routed to Client A's browser.
   * **🖥️ UI Representation:** As soon as Client B joins, both users see a "Key Exchange Success" animation. Client A's screen displays a visual cryptographic footprint (e.g., a massive 1,184-byte hex grid) proving Client B's Post-Quantum Public Key has securely arrived.

## Phase 2: The Entropy Forge (Kinetic & Hardware Randomness)

**Objective:** Generate a 256-bit symmetric encryption key using physical user interactions and system imperfections, completely bypassing predictable pseudo-random number generators (PRNGs).

1. **Kinetic Mouse Tracking:**
   * Client A is prompted to move their mouse randomly within a designated UI zone.
   * The browser captures an array of data points: `(clientX, clientY, performance.now())`.
   * **🖥️ UI Representation:** A dedicated "Entropy Canvas" appears. As Client A moves their mouse, a glowing particle trail follows the cursor, translating physical motion into raw binary data on the screen.
2. **Hardware Performance Jitter Graph:**
   * Simultaneously, the system utilizes `requestAnimationFrame` to measure micro-stutters in frame rendering. Variations in floating-point render times ($\Delta t$) occur due to CPU interrupts, memory load, and thermal throttling.
   * **🖥️ UI Representation:** These micro-variances are plotted live on a real-time oscilloscope-style graph next to the kinetic canvas, visually demonstrating the chaotic hardware entropy being generated.
3. **Entropy Compression & The XOR Safety Net:**
   * The combined kinetic and hardware jitter data is concatenated and compressed using SHA-256 to create a uniformly distributed 32-byte hash.
   * **Mathematical Guarantee:** To ensure maximum security (min-entropy $H_{\infty} \ge 256$ bits), this environmental hash is bitwise XORed with the browser's native `crypto.getRandomValues()`. 
   * **🖥️ UI Representation:** The UI displays a progress bar that locks at 100%, followed by a flash, revealing a masked representation of the final, unforgeable **Symmetric Encryption Key**.

## Phase 3: Zero-Knowledge Client-Side Encryption

**Objective:** Lock the file locally before any data is transmitted over the network.

1. **File Selection & Chunking:** Client A selects a highly sensitive file. For large files, the browser reads the file in chunks using the `FileReader` API.
2. **AES-GCM Local Encryption:**
   * The browser uses the Web Crypto API to encrypt the file using AES-256-GCM, utilizing the user-forged Symmetric Key from Phase 2.
   * An Initialization Vector (IV) is generated locally and prepended to the ciphertext.
3. **File Output:** The original file is transformed into an unreadable, encrypted binary blob (`.enc` file). At this stage, the raw file no longer exists in application memory.
   * **🖥️ UI Representation:** The user sees a split-screen animation. On the left, their original file icon dissolves into binary code; on the right, it reassembles into a locked, color-coded `.enc` block, verifying that local encryption is complete *before* any upload begins.

## Phase 4: Key Encapsulation & Server Upload

**Objective:** Send the locked file and securely pass the Symmetric Key to Client B without the server being able to intercept it.

1. **Symmetric Key Wrapping:**
   * Client A's browser uses Client B's ML-KEM Public Key (retrieved in Phase 1) to encrypt (encapsulate) the highly random Symmetric Key.
   * This creates an encrypted key payload that only Client B's Private Key can unlock.
   * **🖥️ UI Representation:** An animation shows the user's Symmetric Key being placed inside a "Quantum Safe," which is then locked using Client B's unique Public Key pattern.
2. **Payload Transmission:**
   * Client A uploads the `.enc` file, the encrypted Symmetric Key, and the IV to the server.
   * The server stores the `.enc` file and the encrypted key payload in a temporary database, entirely oblivious to the file's contents or the decryption key.
   * **🖥️ UI Representation:** A secure network transfer bar displays the upload progress of the ciphertext, explicitly indicating that "0 plaintext bytes are leaving your device."
3. **Memory Wiping:** Client A's browser explicitly overwrites the Symmetric Key arrays with zeros to prevent memory extraction via XSS attacks.

## Phase 5: Decryption & Ephemeral Burnout (TTL)

**Objective:** Client B securely decrypts the data, followed by immediate and unrecoverable cryptographic destruction of the server-side assets.

1. **Data Retrieval:** Client B requests the payload from the Room. The server delivers the `.enc` file, the IV, and the wrapped Symmetric Key.
2. **Local Key Unwrapping:**
   * Client B's browser uses its locally stored ML-KEM Private Key to decrypt the wrapped payload, revealing the original user-forged Symmetric Key.
   * **🖥️ UI Representation:** Client B sees a decryption terminal un-wrapping the "Quantum Safe" to extract the Symmetric Key locally.
3. **Local File Decryption:**
   * Using the Symmetric Key and the IV, Client B's browser decrypts the `.enc` file back into its original format for download or viewing.
4. **The Ephemeral Burnout (Self-Destruction):**
   * **Download Limits:** If the Room was configured with a "1-Download Limit", the server instantly permanently deletes the `.enc` file and the wrapped key from the database the moment the download stream to Client B completes.
   * **Time-To-Live (TTL):** A background cron job or database TTL index monitors the Room. If the TTL expires (e.g., 24 hours), the server automatically shreds the data.
   * **🖥️ UI Representation (The Burn):** Upon successful download, both Client A and Client B's interfaces trigger a dramatic "Data Burn" visual—the room interface turns red, and the `.enc` file turns to ash on the screen. Finally, a polished, downloadable **Cryptographic Certificate of Destruction** receipt pops up, providing legal proof of data eradication.