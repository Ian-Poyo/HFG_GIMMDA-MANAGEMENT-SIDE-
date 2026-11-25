# GIMMDA — Management Dashboard

The **owner + staff** app for Hill Fitness Gym. Members do not use this.

> This is repo 1 of 2. The member app is a **separate repository**: `gimmda-member`.

---

## What this is

A website. Not a project you build — a folder you serve.

```
index.html                  the app
live-dashboard.js           screens and logic
supabase-integration.js     database connection
supabase.js                 database library (local copy, no CDN)
dm-sans.ttf                 font (local copy, no Google Fonts)
gym-hero.jpg                background photo
hill-logo-monochrome.png    logo
vercel.json                 hosting settings
```

There is **no build step**. No `npm install`. No Node. Nothing to compile.
That is deliberate: a deploy cannot fail because a dependency changed.

Everything loads from this folder — **zero external resources**. If your internet drops,
the app still opens; only the database calls need the network.

---

## Deploy

1. Push this repo to GitHub
2. Vercel → **Add New → Project** → import this repo
3. Framework Preset: **Other**
4. Build Command: **leave empty**
5. Output Directory: **leave empty**
6. **Deploy**

You get `something.vercel.app`. That is your management link — **do not send it to members.**

---

## Push to GitHub

```bash
git init
git add .
git commit -m "GIMMDA management dashboard"
git branch -M main
git remote add origin https://github.com/YOURNAME/gimmda-management.git
git push -u origin main
```

Then in Vercel, import it with **no root directory setting** — this repo *is* the app.

---

## Two repos, one database

```
gimmda-management  (this repo)  ─┐
                                 ├──►  same Supabase database
gimmda-member      (other repo) ─┘
```

Both connect to the same database. A payment recorded here appears in the member's
portal immediately. They are separate codebases, separate repos, separate Vercel
projects — because they are used by different people and one can change without
breaking the other.

---

## Before real members use this

1. **Replace the demo logins.** `@gimmda.test` addresses cannot receive mail.
   Create real accounts in Supabase → Authentication → Users, then set roles on the
   dashboard's **Staff** page.
2. **Run one full day by hand** — open the drawer with a real float, check someone in,
   take a payment, close the drawer, count it.
3. **Don't promise email.** Announcements appear inside the member portal only.
   There is no email or SMS delivery.
4. **Keep Supabase awake.** The free tier pauses after 7 days of inactivity.
