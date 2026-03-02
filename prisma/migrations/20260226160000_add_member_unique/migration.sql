-- AlterTable: add composite unique constraint on Member(gym_id, phone)
ALTER TABLE `Member` ADD CONSTRAINT `Member_gym_id_phone_key` UNIQUE (`gym_id`, `phone`);
