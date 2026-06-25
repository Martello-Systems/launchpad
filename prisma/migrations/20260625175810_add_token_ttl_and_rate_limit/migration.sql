-- AlterTable
ALTER TABLE "Waitlist" ADD COLUMN     "verifyTokenExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimit_resetAt_idx" ON "RateLimit"("resetAt");
