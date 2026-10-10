-- Key roles (protocol 8): Studio's derived key reaches both the Runtime API and the
-- Management API. Every other principal stays an application key.
UPDATE "nylorun"."principals" SET "role" = 'studio' WHERE "id" = 'studio';
