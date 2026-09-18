-- Phase 23: Commercial Offer & Promotion Intelligence.
-- Adds two new ChangeType values so a promotion/offer's full lifecycle
-- (added / changed / removed) can be represented distinctly, the same
-- way PRODUCT_ADDED/PRODUCT_REMOVED already sit alongside PRICE_CHANGE.
-- PROMOTION_CHANGE already existed (added in the initial schema) and is
-- reused as-is for "an existing promotion changed materially".
-- AlterEnum
ALTER TYPE "ChangeType" ADD VALUE 'PROMOTION_ADDED';
ALTER TYPE "ChangeType" ADD VALUE 'PROMOTION_REMOVED';
