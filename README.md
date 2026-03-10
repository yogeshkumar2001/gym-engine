# Gym Renewal Engine

Multi-tenant Gym Membership Renewal Automation System — Phase 1 Backend Foundation.

---

## Tech Stack

- **Runtime**: Node.js (CommonJS)
- **Framework**: Express 5
- **Database**: MySQL
- **ORM**: Prisma 7
- **Validation**: Joi
- **Logging**: Winston + Morgan
- **Security**: Helmet, CORS, express-rate-limit

---

## Folder Structure

```
gym-renewal-engine/
├── prisma/
│   └── schema.prisma          # Database schema (Gym, Member models)
├── src/
│   ├── config/
│   │   └── logger.js          # Winston logger
│   ├── controllers/
│   │   └── gym.controller.js  # Request handlers
│   ├── cron/                  # Scheduled jobs (Phase 2+)
│   ├── lib/
│   │   └── prisma.js          # Prisma client singleton
│   ├── routes/
│   │   ├── index.js           # Route aggregator
│   │   └── gym.routes.js      # Gym-specific routes
│   ├── services/
│   │   └── gym.service.js     # Business logic / DB queries
│   └── utils/
│       ├── gymValidator.js    # Joi validation schemas
│       └── response.js        # Standardised JSON response helpers
├── server.js                  # App entry point
├── prisma.config.ts           # Prisma CLI config
├── .env.example               # Environment variable template
└── package.json
```

---

## Installation

### 1. Clone & install dependencies

```bash
git clone <repo-url>
cd gym-renewal-engine
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
DATABASE_URL="mysql://root:your_password@localhost:3306/gym_renewal"
PORT=4000
NODE_ENV=development
INTERNAL_SECRET=your_secret_here
```

### 3. MySQL setup

Create the database in MySQL:

```sql
CREATE DATABASE gym_renewal;
```

### 4. Run Prisma migration

```bash
npx prisma migrate dev --name init
```

This creates the `Gym` and `Member` tables with the correct schema.

### 5. Generate Prisma client

```bash
npx prisma generate
```

---

## Running the Server

### Development (with auto-restart)

```bash
npm run dev
```

### Production

```bash
npm start
```

Server starts on `http://localhost:4000` by default.

---

## API Endpoints

All responses follow the shape:

```json
{ "success": true|false, "message": "...", "data": {...} }
```

### GET /health

Check server status.

```bash
curl http://localhost:4000/health
```

**Response 200:**
```json
{
  "success": true,
  "message": "Server is healthy.",
  "timestamp": "2026-02-26T10:00:00.000Z",
  "environment": "development"
}
```

---

### POST /gym

Register a new gym.

```bash
curl -X POST http://localhost:4000/gym \
  -H "Content-Type: application/json" \
  -d '{
    "name": "FitZone Gym",
    "razorpay_key_id": "rzp_test_xxx",
    "razorpay_key_secret": "secret_xxx",
    "razorpay_webhook_secret": "webhook_xxx",
    "whatsapp_phone_number_id": "1234567890",
    "whatsapp_access_token": "EAAxxxxx",
    "google_sheet_id": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
    "owner_phone": "+919876543210"
  }'
```

**Response 201:**
```json
{
  "success": true,
  "message": "Gym created successfully.",
  "data": {
    "id": 1,
    "name": "FitZone Gym",
    "owner_phone": "+919876543210",
    "created_at": "2026-02-26T10:00:00.000Z"
  }
}
```

**Response 400 (validation failure):**
```json
{
  "success": false,
  "message": "Validation failed.",
  "errors": ["\"name\" is not allowed to be empty"]
}
```

---

### GET /gym/:id

Fetch gym details by ID. Sensitive fields (`razorpay_key_secret`, `whatsapp_access_token`) are excluded.

```bash
curl http://localhost:4000/gym/1
```

**Response 200:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": 1,
    "name": "FitZone Gym",
    "razorpay_key_id": "rzp_test_xxx",
    "razorpay_webhook_secret": "webhook_xxx",
    "whatsapp_phone_number_id": "1234567890",
    "google_sheet_id": "1BxiMVs0XRA5nFM...",
    "owner_phone": "+919876543210",
    "created_at": "2026-02-26T10:00:00.000Z"
  }
}
```

**Response 404:**
```json
{ "success": false, "message": "Gym not found." }
```

---

## Security Notes

- No secrets are hardcoded — all read from `process.env`
- `razorpay_key_secret` and `whatsapp_access_token` are never returned by the API
- Rate limiting: 100 requests per 15 minutes per IP
- Helmet sets secure HTTP headers
