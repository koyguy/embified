output "public_ip" {
  description = "Public IP — set EMBIFIED_AUTH_PASSWORD before sharing the inbox."
  value       = oci_core_instance.vault.public_ip
}

output "instance_ocid" {
  value = oci_core_instance.vault.id
}

output "volume_ocid" {
  value = oci_core_volume.data.id
}

output "ssh_hint" {
  value = "ssh -i <private-key> ubuntu@${oci_core_instance.vault.public_ip}"
}

output "post_apply_notes" {
  value = <<-EOT
    1. Wait ~5–10 min for cloud-init (Node + npm build).
    2. ssh ubuntu@<public_ip>  then:  sudo journalctl -u embified -n 80 --no-pager
    3. Before sharing the IP, set the inbox password:
         sudo install -d -m 700 /etc/embified
         echo 'EMBIFIED_AUTH_PASSWORD=your-strong-password' | sudo tee /etc/embified/auth.env
         sudo chmod 600 /etc/embified/auth.env
         sudo systemctl restart embified
    4. Open http://<public_ip>/vault (public) and http://<public_ip>/login (inbox).
  EOT
}
