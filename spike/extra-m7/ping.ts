import { MongoClient } from "mongodb"
const c = new MongoClient(process.env.MONGO_ADMIN_URL!)
console.log("ping", (await c.db("admin").command({ ping: 1 })).ok)
await c.close()
