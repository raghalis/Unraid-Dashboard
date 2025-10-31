# Unraid Dashboard (Control Panel)

Single WebUI to view/control multiple Unraid hosts:
- Power: Wake (WOL), Reboot, Shutdown
- Docker: list / start / stop / restart
- VMs: list / start / stop / reset
- Settings page to add/edit hosts and tokens

## Run (Unraid or any Docker host)

```bash
docker run -d --name unraid-dashboard \
  --network host \
  -e BASIC_AUTH_USER=admin \
  -e BASIC_AUTH_PASS=change_me \
  -e UNRAID_ALLOW_SELF_SIGNED=true \
  -e WOL_BROADCAST=255.255.255.255 \
  -e WOL_INTERFACE=eth0 \
  -v /mnt/user/appdata/unraid-dashboard/data:/app/data \
  ghcr.io/<you>/unraid-dashboard:latest
