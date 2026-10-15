# DsignX Ops: setup guide

This guide takes you from nothing to a live, working DsignX Ops site, one step at a time. It takes about an hour the first time. You only do it once.

**What you'll end up with:**

| Part | Service | Cost |
|---|---|---|
| The website | GitHub Pages | Free |
| Logins and data | Firebase (Google) | Free allowance; a bank card is required |
| WhatsApp | Bird | Per message, as now |
| Files sent on WhatsApp | Cloudinary | Free plan |

**Before you start, have these ready:**
- A Google account. Your work Gmail or Google Workspace account is fine.
- A bank card, for Firebase's Blaze plan.
- Your Bird login.
- Your Cloudinary login.
- A GitHub account.
- The file **dsignx-ops-backup-2026-10-14.json**, your data from the Claude version. Keep this file private and **never upload it to GitHub**.

**How to read this guide:**
- Type each command exactly as shown, then press Enter.
- **Windows:** use **Git Bash**, which comes with Git (Part 5).
- **Mac:** use **Terminal**.

---

## Part 1: Create the Firebase project

1. Go to <https://console.firebase.google.com> and sign in with your Google account.
2. Click **Create a project** (or **Add project**).
3. Name it `dsignx-ops`. Firebase may add a few random letters to make the ID unique. That's fine.
4. Google Analytics isn't needed. Switch it **off**, then click **Create project**.
5. When it's ready, click **Continue**.

### Switch on the Blaze (pay-as-you-go) plan
The server functions that talk to Bird and Cloudinary need it. Normal use for a small team stays inside the free allowance.

1. Bottom-left of the console, click **Spark plan → Upgrade**.
2. Choose **Blaze**, then add your card.
3. When asked, set a **budget alert**, for example **$5**. Google emails you if spending ever approaches it.

---

## Part 2: Create the database

1. Left menu: **Build → Firestore Database → Create database**.
2. **Location:** choose **africa-south1 (Johannesburg)** if it's listed. Otherwise choose **europe-west1 (Belgium)**.

   ⚠️ You can't change the location later.
3. Choose **Start in production mode**, then click **Create**.

You don't need to edit the rules here. They are uploaded from your files in Part 7.

---

## Part 3: Switch on email sign-in

1. Left menu: **Build → Authentication → Get started**.
2. Under **Sign-in method**, click **Email/Password**.
3. Switch on the first toggle (**Email/Password**), then click **Save**.
4. Open the **Settings** tab, then **Authorized domains**, then **Add domain**.
5. Enter `YOUR-USERNAME.github.io`, replacing `YOUR-USERNAME` with your GitHub username. Click **Add**.

---

## Part 4: Register the web app and fill in `firebase-config.js`

1. Click the **gear icon** next to *Project Overview*, then **Project settings**.
2. Scroll to **Your apps** and click the **web icon `</>`**.
3. Nickname: `DsignX Ops web`.
   - Leave **Firebase Hosting** unticked, because you're using GitHub Pages.
   - Click **Register app**.
4. Firebase shows a code block containing `const firebaseConfig = { ... }`. Keep that page open.
5. Unzip **dsignx-ops.zip**, for example into your **Documents** folder.
6. Open `dsignx-ops/js/firebase-config.js` in a text editor:
   - **Windows:** Notepad.
   - **Mac:** TextEdit. Choose *Format → Make Plain Text* first.
7. Copy each value from Firebase into the matching line between the quotes, for example:
   ```js
   apiKey: "AIzaSy...",
   authDomain: "dsignx-ops-ab12c.firebaseapp.com",
   projectId: "dsignx-ops-ab12c",
   storageBucket: "dsignx-ops-ab12c.firebasestorage.app",
   messagingSenderId: "1234567890",
   appId: "1:1234567890:web:abc123..."
   ```
8. Leave `functionsRegion` and `ownerEmail` as they are, unless:
   - you want a different owner email. Change it here **and** in `firestore.rules`.
   - you change the function region later. Change it here **and** in `functions/index.js`.
9. Save the file.

These values are not secret. They only tell the app which Firebase project to use.

---

## Part 5: Install the tools

### 5.1 Install Git
- **Windows:** download it from <https://git-scm.com/download/win> and run the installer. The default options are fine. This also installs **Git Bash**.
- **Mac:** open Terminal and type `git --version`. If Git is missing, macOS offers to install it.

### 5.2 Install Node.js
Download the **LTS** version (22 or newer) from <https://nodejs.org> and install it with the default options. Close the terminal and open it again, then check that it worked:
```bash
node --version
npm --version
```
Both commands should print version numbers.

### 5.3 Install the Firebase command-line tool
```bash
npm install -g firebase-tools
```
On a Mac, if you get a permissions error, run `sudo npm install -g firebase-tools` and type your Mac password.

Then sign in. A browser window opens; choose the same Google account and click **Allow**:
```bash
firebase login
```

---

## Part 6: Get your Bird and Cloudinary keys

### Bird API key
1. Sign in at <https://bird.com/dashboard>.
2. Go to **Platform tools → API keys → Create**.
3. Name it `DsignX Ops`.
4. Scopes:
   - **whatsapp** set to **write**.
   - Optionally, **whatsapp_management** set to **read**.
5. Create the key, then **copy it straight away**. It starts with `bk_` and is shown only once.

### Cloudinary URL
1. Sign in at <https://console.cloudinary.com>.
2. Find the **API environment variable**:
   - Go to **Settings (gear) → API Keys**, or the dashboard.
   - It looks like `CLOUDINARY_URL=cloudinary://123456789012345:AbCdEf...@fkg0566i`.
3. Copy only the part **after** `CLOUDINARY_URL=`, starting with `cloudinary://`. Replace `<your_api_secret>` with the real secret if it's hidden; click the eye icon to reveal it.

Keep both keys somewhere safe, such as a password manager. **Don't paste them into any project file.**

---

## Part 7: Deploy the database rules and server functions

In the terminal, go into the project folder:
```bash
cd ~/Documents/dsignx-ops
```

Link the folder to your Firebase project:
```bash
firebase use --add
```
Use the arrow keys to pick your `dsignx-ops-...` project and press Enter. When it asks for an alias, type `default` and press Enter.

Install and test the server code:
```bash
cd functions
npm install
npm test
cd ..
```
`npm test` should end with `# pass 7` and `# fail 0`.

Store the two keys as secrets. Paste each key when asked; nothing shows while you paste, which is normal. Press Enter after each one.
```bash
firebase functions:secrets:set BIRD_API_KEY
firebase functions:secrets:set CLOUDINARY_URL
```

Deploy:
```bash
firebase deploy --only firestore:rules,firestore:indexes,functions
```

- The first deploy takes several minutes and may ask to enable some Google APIs. Answer **Y**.
- It asks for **WA_FROM**, the WhatsApp business number, with `+27604934689` already filled in. Press **Enter** to accept it.
- If it fails with an error about APIs "being enabled", wait 2 minutes and run the same command again.
- It's finished when you see **✔ Deploy complete!**

---

## Part 8: Put the website on GitHub Pages

1. Sign in at <https://github.com>.
2. Click **+**, then **New repository**:
   - Name: `dsignx-ops`.
   - **Public**. Free GitHub Pages needs a public repository.
   - Don't add a README, .gitignore or licence.
   - Click **Create repository**.
3. In the terminal, still in the `dsignx-ops` folder, run the following. Replace `YOUR-USERNAME` with your GitHub username.
   ```bash
   git config --global user.name "Estelle Britz"
   git config --global user.email "estelle@dsignx.co.za"
   git init
   git add .
   git status
   ```
   Check the `git status` list. It must **not** include any `backup` file or `node_modules`; `.gitignore` takes care of this. If it shows `*backup*.json`, you've saved the backup file inside this folder. Move it out, then run `git add .` again.
   ```bash
   git commit -m "DsignX Ops with Firebase"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/dsignx-ops.git
   git push -u origin main
   ```
   If the terminal asks for a password, a browser sign-in should open. If it doesn't, use a GitHub **personal access token** as the password:
   - Go to **Settings → Developer settings → Personal access tokens → Tokens (classic)**.
   - Generate a new token with the **repo** box ticked.
   - Paste the token when asked for the password.

   **Already created a `dsignx-ops` repository earlier for the demo?** Use these steps instead:
   - Copy the new files over the old folder.
   - Run `git add .`, then `git commit -m "Firebase version"`, then `git push`.
4. On GitHub, open the repository and go to **Settings → Pages**:
   - **Source:** Deploy from a branch.
   - **Branch:** `main`.
   - **Folder:** `/ (root)`.
   - Click **Save**.
5. After 1–2 minutes, refresh the page. It shows **"Your site is live at https://YOUR-USERNAME.github.io/dsignx-ops/"**.

---

## Part 9: First sign-in and importing your data

1. Open `https://YOUR-USERNAME.github.io/dsignx-ops/`.
2. Click **First-time owner setup**.
3. Enter **estelle@dsignx.co.za** and choose a strong password (at least 8 characters). Click **Create owner account**.
4. Click **Send verification email**. Open the email from Firebase (check spam if needed), click the link, then come back and tap **I've clicked the link — continue**.
5. Click **Make me the owner**. This works only once, and only for the verified owner email.

   Do this straight after deploying. Until the owner is set up, the setup screen is open to anyone who owns that inbox.
6. Go to **Settings**. Under **Import data**, click **Choose backup file…** and pick **dsignx-ops-backup-2026-10-14.json**. Confirm.
7. Wait for **Imported 846 records**. Your 834 customers, jobs, team list, business details and invoice numbering are now in place.
8. Check **Settings → Letterhead on quotes & invoices** and **Invoice defaults** (banking details) before sending your first document.

---

## Part 10: Invite your team

1. Go to **Team** and click **Invite** next to a person.
2. Send the invite by WhatsApp, or copy it. The message contains the website link and an 8-character code, valid for 7 days.
3. The team member opens the link and taps **I have an invite code**. They enter their own email, choose a password and type the code.
4. After that, they sign in with their email and password.

To remove someone, use **Team → Revoke** next to their name. They are signed out straight away.

---

## Day-to-day

- **Forgot password:** on the sign-in screen, type your email and tap **Forgot password?**. Firebase emails a reset link, which may land in spam the first time.
- **Signing out:** use **Lock**, or close the tab. The app also signs out after 30 minutes without activity.
- **Updating the website after a change:**
  ```bash
  git add .
  git commit -m "What changed"
  git push
  ```
- **Updating the server functions or rules:**
  ```bash
  firebase deploy --only firestore:rules,functions
  ```
- **Changing a key:** run `firebase functions:secrets:set BIRD_API_KEY` (or `CLOUDINARY_URL`), then `firebase deploy --only functions`.
- **Server logs:** run `firebase functions:log`. These help when WhatsApp sending fails.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| The site shows **Demo mode … Firebase isn't configured** | `js/firebase-config.js` is still empty or wasn't pushed. Fill it in (Part 4), then `git add . && git commit -m "config" && git push`. |
| Sign-in error **auth/unauthorized-domain**, or nothing happens | Add `YOUR-USERNAME.github.io` under Authentication → Settings → Authorized domains (Part 3). |
| **Make me the owner** fails | You must be signed in with exactly the email in `firestore.rules` and `firebase-config.js`, that email must be verified (click the link in the verification email), and the rules must be deployed (Part 7). |
| Invite code **isn't valid** | Each code works once and expires after 7 days. A new invite replaces the old code. Send a new invite. |
| WhatsApp: **isn't set up on the server yet** | A secret is missing. Run Part 7's `secrets:set` commands again, then `firebase deploy --only functions`. |
| WhatsApp: **24-hour reply window is closed** | WhatsApp only allows replies within 24 hours of the customer's last message. Ask them to message you first. |
| WhatsApp: **rejected the API key** | The Bird key is wrong, expired or missing the **whatsapp: write** scope. Create a new key and set it again. |
| `firebase deploy` says **Blaze plan required** | Upgrade the project to Blaze (Part 1). |
| GitHub Pages shows a **404** | Wait 2 minutes. Check that Settings → Pages shows `main` / `(root)` and that `index.html` is at the top of the repository. |

---

## Good to know

- **Two copies:** the Claude version and this version don't share data. Once you've switched, stop using the Claude version so jobs aren't split between the two.
- **Order link:** Settings → WhatsApp still points customers to 060 493 4689, which the inbox reads through Bird.
- **Costs to watch:**
  - Bird bills per WhatsApp message.
  - Firebase stays free at DsignX's volume. The budget alert from Part 1 warns you if that changes.
  - Cloudinary's free plan is plenty, because old PDFs are deleted after 30 days.
