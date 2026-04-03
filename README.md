# Prayas Citizen Engagement Platform

Prayas is a district-facing citizen engagement portal that combines beautiful public-facing mission discovery with a shared backend for real multi-user participation.

This version keeps the stronger `prayas.html` visual language and adds a real Node + SQLite data layer so citizen submissions and admin actions are shared across users instead of living only in one browser.

## Stack

- Frontend: single-page HTML/CSS/JS portal in `index.html`
- Backend: `server.js` using Node's built-in HTTP server
- Database: SQLite via Node's built-in `node:sqlite`
- Auth: server-side admin password check with signed admin tokens

## Features

- Mission browsing with category and ward filters
- Mission discussions
- Volunteer registration stored in SQLite
- Story publishing with comments and cheers
- Crowdfunding progress stored in SQLite
- Sponsor lead capture stored in SQLite
- Newsletter subscriber capture stored in SQLite
- Admin login with server-side token validation
- Admin mission posting
- Admin announcement posting
- Admin newsletter draft saving
- Hindi toggle, dark mode, and font scaling

## Project Files

- `index.html`: public portal UI
- `server.js`: API server, auth, SQLite schema, and seed logic
- `package.json`: run scripts
- `.env.example`: environment variables
- `data/`: runtime SQLite database folder

## Local Run

1. Open a terminal in the repo.
2. Optionally copy `.env.example` to `.env` and adjust values for production.
3. Start the app:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000)

If you want a different port:

```bash
PORT=4301 node server.js
```

## Environment Variables

- `PORT`: server port
- `PRAYAS_ADMIN_PASSWORD`: admin password used by the login modal
- `PRAYAS_TOKEN_SECRET`: signing secret for admin session tokens

## Database Notes

- The SQLite file is created automatically at `data/prayas.sqlite`
- The database is seeded on first run with starter missions, stories, funds, leaders, and announcements
- `data/*.sqlite` is gitignored so local runtime data does not get committed by accident

## Production Notes

- This is now a true shared-data portal suitable for deployment on a Node-capable host
- It is not a GitHub Pages-only static site anymore because the portal now depends on the backend API and SQLite database
- Before public deployment, replace the default admin password and token secret with strong environment values
