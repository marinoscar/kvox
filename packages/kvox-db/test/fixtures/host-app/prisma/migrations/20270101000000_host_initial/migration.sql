-- Fixture host history: the three tables the domain migrations reference.
CREATE TABLE "users" ("id" UUID NOT NULL, "email" TEXT NOT NULL, CONSTRAINT "users_pkey" PRIMARY KEY ("id"));
