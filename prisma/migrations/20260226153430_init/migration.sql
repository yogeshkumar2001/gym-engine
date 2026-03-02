-- CreateTable
CREATE TABLE `Gym` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `razorpay_key_id` VARCHAR(191) NOT NULL,
    `razorpay_key_secret` VARCHAR(191) NOT NULL,
    `razorpay_webhook_secret` VARCHAR(191) NOT NULL,
    `whatsapp_phone_number_id` VARCHAR(191) NOT NULL,
    `whatsapp_access_token` VARCHAR(191) NOT NULL,
    `google_sheet_id` VARCHAR(191) NOT NULL,
    `owner_phone` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Member` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gym_id` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `plan_name` VARCHAR(191) NOT NULL,
    `plan_amount` DOUBLE NOT NULL,
    `join_date` DATETIME(3) NOT NULL,
    `expiry_date` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `last_reminder_sent_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Member` ADD CONSTRAINT `Member_gym_id_fkey` FOREIGN KEY (`gym_id`) REFERENCES `Gym`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
