-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'CASH';
ALTER TYPE "PaymentMethod" ADD VALUE 'TRANSFER';

-- DropIndex
DROP INDEX "Subscription_mpPreapprovalId_key";

-- DropIndex
DROP INDEX "Payment_mpPaymentId_key";

-- DropIndex
DROP INDEX "Payment_tenantId_status_idx";

-- AlterTable
ALTER TABLE "Tenant" DROP COLUMN "aiEnabled",
DROP COLUMN "botPersona",
ADD COLUMN     "botEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "welcomeMessage" TEXT;

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "history",
ADD COLUMN     "state" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "method",
DROP COLUMN "mpPreapprovalId";

-- Cobranças do Mercado Pago não pagas não fazem sentido no modelo manual.
DELETE FROM "Payment" WHERE "status" <> 'APPROVED';

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "expiresAt",
DROP COLUMN "mpPaymentId",
DROP COLUMN "pixQrCode",
DROP COLUMN "pixQrCodeBase64",
DROP COLUMN "status",
DROP COLUMN "ticketUrl",
DROP COLUMN "updatedAt",
ADD COLUMN     "months" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "notes" TEXT,
ALTER COLUMN "paidAt" SET NOT NULL,
ALTER COLUMN "paidAt" SET DEFAULT CURRENT_TIMESTAMP;

-- DropEnum
DROP TYPE "PaymentStatus";

-- CreateIndex
CREATE INDEX "Payment_tenantId_paidAt_idx" ON "Payment"("tenantId", "paidAt");

