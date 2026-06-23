-- AlterTable: add double-opt-in verification columns.
ALTER TABLE "Waitlist" ADD COLUMN "verifyToken" TEXT;
ALTER TABLE "Waitlist" ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Waitlist_verifyToken_key" ON "Waitlist"("verifyToken");
