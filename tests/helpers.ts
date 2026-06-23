import { PrismaClient } from "@prisma/client";
import type { Mailer, MailMessage } from "../lib/mailer";

// A fresh client bound to whatever DATABASE_URL the setup file pinned (test DB).
export const prisma = new PrismaClient();

/** Truncate all rows between tests for isolation. */
export async function resetDb(): Promise<void> {
  // CASCADE handles the self-referential FK; RESTART IDENTITY is harmless here.
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Waitlist" RESTART IDENTITY CASCADE');
}

/** A capturing mock mailer for assertions. */
export class MockMailer implements Mailer {
  public sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<{ id: string | null }> {
    this.sent.push(msg);
    return { id: `mock-${this.sent.length}` };
  }
  reset(): void {
    this.sent = [];
  }
}
