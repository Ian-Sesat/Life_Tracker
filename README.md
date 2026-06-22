# Life Tracker

A personal goal and spending tracker with a real backend. Each person signs up
with an email and password, and their data (goals, sub-goals, daily completions,
expenses, categories) is stored in the cloud and synced across all their devices.
Everyone uses the same URL but only ever sees their own data.

Built with React + Vite. Backend is Supabase (free tier).

---

## One-time setup

You need Node.js 18+ (https://nodejs.org) and a free Supabase account.

### 1. Create a Supabase project

1. Go to https://supabase.com, sign up, and create a new project.
   - Pick a region close to you (e.g. Frankfurt / EU Central for Germany).
   - Set a database password (keep it safe; the app doesn't need it).
2. Wait ~2 minutes for provisioning to finish.

### 2. Create the database table

1. In the dashboard: SQL Editor -> New query.
2. Open `supabase-setup.sql` from this project, copy all of it, paste, click Run.
   This creates the tracker_state table and the rules that keep data private.

### 3. Get your two keys

Dashboard -> Project Settings (gear) -> API. Copy the Project URL and the
anon public key.

### 4. Add the keys to the app

1. Copy `.env.example` to a new file named `.env`.
2. Fill in:

       VITE_SUPABASE_URL=https://your-project-ref.supabase.co
       VITE_SUPABASE_ANON_KEY=your-anon-public-key

The anon key is meant to be public; the SQL security rules protect the data.

### 5. (Optional) easy signup

By default Supabase emails a confirmation link on sign-up. For a small group you
can skip it: Authentication -> Providers -> Email -> turn off "Confirm email".
Then friends can sign up and log in immediately.

---

## Run locally

    npm install
    npm run dev

Open the printed URL (usually http://localhost:5173). Sign up and you're in.

---

## Deploy and share

### Vercel (recommended)

1. Put this folder in a GitHub repo (git init, commit, push).
2. On vercel.com, sign in with GitHub, import the repo.
3. Add two environment variables under Settings -> Environment Variables:
   - VITE_SUPABASE_URL
   - VITE_SUPABASE_ANON_KEY
   (same values as your local .env)
4. Deploy. You get a URL like life-tracker-xyz.vercel.app.
5. Send it to your 4 friends. Each signs up with their own email and gets their
   own private, synced tracker.

### Netlify

Connect the repo and set the same two environment variables under
Site settings -> Environment variables, then deploy. (Plain drag-and-drop of
dist won't carry the env vars, so use the Git connection.)

---

## Notes

- Privacy between users is enforced by Supabase row-level security (the SQL you
  ran). Each logged-in user can only read/write their own row.
- The free tier easily covers a handful of users. Free projects pause after a
  week of total inactivity; opening the app wakes it.
- Want a shared group tracker later (everyone editing the same goals)? That's a
  different data model and can be added.
- The app shows a setup-reminder screen until the .env values are provided.
