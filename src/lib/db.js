import { PrismaClient } from "@prisma/client";

// Prisma client singleton (survives dev hot reloads)
const globalForPrisma = globalThis;
export const db = globalForPrisma.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = db;
