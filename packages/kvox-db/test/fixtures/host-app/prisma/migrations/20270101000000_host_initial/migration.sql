-- Fixture host history: the four tables the domain migrations reference.
CREATE TABLE "users" ("id" UUID NOT NULL, "email" TEXT NOT NULL, CONSTRAINT "users_pkey" PRIMARY KEY ("id"));
CREATE TABLE "organizations" ("id" UUID NOT NULL, CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"));
