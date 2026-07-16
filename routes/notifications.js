import express from "express";
import Notification from "../models/notification_model.js";

const notificationsRouter = express.Router();

notificationsRouter.get("/notifications", async (req, res) => {
  try {
    const { clerkId, limit = 30 } = req.query;

    if (!clerkId) {
      return res.status(400).json({ success: false, error: "Missing clerkId" });
    }

    const notifications = await Notification.find({ clerkId })
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    const unreadCount = await Notification.countDocuments({ clerkId, read: false });

    return res.status(200).json({
      success: true,
      data: notifications,
      unreadCount,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

notificationsRouter.post("/notifications/:id/read", async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { $set: { read: true } },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, error: "Notification not found" });
    }

    return res.status(200).json({ success: true, data: notification });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

notificationsRouter.post("/notifications/read-all", async (req, res) => {
  try {
    const { clerkId } = req.body;

    if (!clerkId) {
      return res.status(400).json({ success: false, error: "Missing clerkId" });
    }

    await Notification.updateMany({ clerkId, read: false }, { $set: { read: true } });

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default notificationsRouter;
