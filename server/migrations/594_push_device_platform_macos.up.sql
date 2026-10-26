-- The fork desktop app registers APNs tokens too.
ALTER TABLE push_device DROP CONSTRAINT IF EXISTS push_device_platform_check;
ALTER TABLE push_device ADD CONSTRAINT push_device_platform_check CHECK (platform IN ('ios', 'macos'));
