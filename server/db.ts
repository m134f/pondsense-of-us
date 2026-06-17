import mysql from "mysql2/promise";

export function hasDbConfig() {
  return Boolean(process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_DATABASE);
}

export const pool = hasDbConfig()
  ? mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      ssl: process.env.MYSQL_SSL === "true" ? { rejectUnauthorized: true } : undefined,
      waitForConnections: true,
      connectionLimit: 10
    })
  : null;
