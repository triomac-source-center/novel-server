import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import morgan from 'morgan'
import mongoose from 'mongoose'

let app = express()
dotenv.config()
app.use(morgan('dev'))
app.use(express.json({ limit: '50mb' }))
app.use(cors())
app.use(express.urlencoded({ extended: false }))

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running ...on port ${PORT} Done!`)
})
