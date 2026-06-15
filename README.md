# PondSense of Us

Beginner-friendly full-stack starter for the capstone project **A Digital Decision Support System for Fish Pond Management**.

## Tech Stack From The Paper

- Frontend: React.js, Vite, Tailwind CSS, Recharts, Lucide icons
- Backend: Node.js with Express.js
- Database-ready: MySQL using `mysql2`
- Hardware-ready: ESP32 can send readings to `POST /api/readings`

## How To Run In VS Code

1. Open this folder in VS Code.
2. Open the terminal in VS Code.
3. Run:

```bash
npm install
npm run dev
```

4. Open the web URL shown by Vite, usually:

```text
http://localhost:5173
```

The frontend works even if MySQL is not configured yet. User accounts, history, language, admin PIN, and fish edits are saved in browser `localStorage` first, so you can demo the Decision Support System immediately.

## XAMPP MySQL Setup

1. Start Apache and MySQL in XAMPP.
2. Open `http://localhost/phpmyadmin`.
3. Create a database named `pondsense`.
4. Import `server/schema.sql`.
5. Copy `.env.example` to `.env`.
6. Use the usual XAMPP default settings:

```env
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=pondsense
```

7. Restart `npm run dev`.

The schema follows the Replit database blueprint:

- `users`: registered farmers/admin accounts
- `water_readings`: manual or ESP32 water quality readings
- `alerts`: warning/critical alerts generated per reading
- `corrective_action_log`: farmer notes on actions taken
- `fish_species`: the 8 fish species and optimal parameter ranges
- `admin_settings`: admin PIN and future system settings

## Why This Is A Decision Support System

PondSense does monitoring, but it also analyzes readings, scores fish suitability, detects risk, recommends corrective actions, provides feeding guidance, stores history, shows trends, and supports admin management.
