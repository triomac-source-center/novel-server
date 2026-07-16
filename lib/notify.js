import Notification from "../models/notification_model.js";

/**
 * Creates a notification for a user. Never throws - a notification
 * failure should never break the main action (deposit, invest, etc.).
 */
export async function notify({ clerkId, type, title, message = "", relatedId = null }) {
  try {
    const notification = await Notification.create({
      clerkId,
      type,
      title,
      message,
      relatedId,
    });
    return notification;
  } catch (error) {
    console.error("Notification creation failed:", error);
    return null;
  }
}
