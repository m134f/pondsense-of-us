import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const required = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`Missing required environment values: ${missing.join(", ")}`);
  process.exit(1);
}

const schemaPath = path.resolve("server", "schema.sql");
const schema = await fs.readFile(schemaPath, "utf8");

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  multipleStatements: true,
  ssl: process.env.MYSQL_SSL === "true" ? { rejectUnauthorized: true } : undefined
});

try {
  await connection.query(schema);
  const [tables] = await connection.query("SHOW TABLES");
  console.log("Schema imported successfully.");
  console.table(tables);
} finally {
  await connection.end();
}
