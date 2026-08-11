import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import morgan from 'morgan'
import mongoose from 'mongoose'
import { clerkMiddleware } from '@clerk/express'
import depositRouter from './routes/deposit.js'
import clusterRouter from './routes/cluster_route.js'
import allClusRouter from './routes/get_clus_router.js'
import accountRouter from './routes/account.js'
import withdrawRouter from './routes/withdraw.js'
import notificationsRouter from './routes/notifications.js'
import usersRouter from './routes/users.js'
import blockRouter from './routes/authorship_block_route.js'
import adminResetRouter from './routes/admin_reset_route.js'
import walletDepositRouter from './routes/wallet_deposit_route.js'
import walletWithdrawRouter from './routes/wallet_withdraw_route.js'

let app = express()
dotenv.config()
// Render sits in front of this app as a reverse proxy — without this, req.ip is the proxy's
// internal address for every request, which would bucket every visitor under one shared IP for
// the admin rate limiter (see lib/admin.js) instead of the real client address.
app.set('trust proxy', 1)
app.use(morgan('dev'))
app.use(express.json({ limit: '50mb' }))
app.use(cors())
app.use(express.urlencoded({ extended: false }))
// Parses/attaches Clerk auth when a valid session token is present; never blocks a request on its
// own (that's what requireAuth()/requireAdminAccess do per-route) — safe to mount globally.
app.use(clerkMiddleware())

const mongo_ui = process.env.MONGO_UI

if (mongoose.connection.readyState === 0) {
    mongoose.connect(mongo_ui, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    })
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));
}

app.get('/', (req, res) => {
    res.json({message: "wellcome home"})
})

app.use("/api", depositRouter);
app.use("/api", clusterRouter);
app.use("/api", accountRouter);
app.use("/api", withdrawRouter);
app.use("/api", notificationsRouter);
app.use("/api", usersRouter);
app.use("/api", blockRouter);
app.use("/api", adminResetRouter);
app.use("/api", walletDepositRouter);
app.use("/api", walletWithdrawRouter);
app.use("/api/all", allClusRouter);

// Generic Clerk-id lookup (used by fetchUserProfile). Registered last so it only catches
// single-segment paths that none of the routers above already claimed — mounting it first
// used to shadow GET /api/account and GET /api/notifications, since express matched this
// route before ever reaching accountRouter/notificationsRouter.
app.get("/api/:id", async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const user = await db.collection("users").findOne({ clerkId: req.params.id });

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});


const PORT = process.env.PORT || 8000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running ...on port ${PORT} Done!`)
})
