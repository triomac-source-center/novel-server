import mongoose from "mongoose";

const { Schema } = mongoose;

const NotificationSchema = new Schema({
  clerkId: {
    type: String,
    required: true,
    index: true,
  },

  type: {
    type: String,
    enum: [
      "deposit",
      "withdraw",
      "invest",
      "cluster_created",
      "cluster_filled",
      "system",
    ],
    required: true,
  },

  title: {
    type: String,
    required: true,
  },

  message: {
    type: String,
    default: "",
  },

  read: {
    type: Boolean,
    default: false,
  },

  relatedId: {
    type: String,
    default: null,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Notification = mongoose.model("notifications", NotificationSchema);

export default Notification;
