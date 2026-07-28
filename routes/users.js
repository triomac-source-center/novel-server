import express from "express";
import mongoose from "mongoose";

const usersRouter = express.Router();

const getUsersCollection = () => mongoose.connection.collection("users");

usersRouter.get("/users/lookup", async (req, res) => {
  try {
    const { clerkIds } = req.query;
    const ids = String(clerkIds || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const Users = getUsersCollection();
    const users = await Users.find(
      { clerkId: { $in: ids } },
      { projection: { clerkId: 1, username: 1, firstName: 1, lastName: 1 } }
    ).toArray();

    const data = users.map((user) => ({
      clerkId: user.clerkId,
      username: user.username || null,
      firstName: user.firstName || null,
      lastName: user.lastName || null,
    }));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Users lookup error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default usersRouter;
