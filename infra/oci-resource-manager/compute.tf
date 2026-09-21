resource "oci_core_instance" "vault" {
  availability_domain = local.ad
  compartment_id      = var.compartment_ocid
  display_name        = var.display_name
  shape               = var.shape

  dynamic "shape_config" {
    for_each = can(regex("Flex", var.shape)) ? [1] : []
    content {
      ocpus         = var.ocpus
      memory_in_gbs = var.memory_in_gbs
    }
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = var.assign_public_ip
    display_name     = "${var.display_name}-vnic"
    hostname_label   = "embified"
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      embified_git_url = var.embified_git_url
      embified_git_ref = var.embified_git_ref
    }))
  }

  preserve_boot_volume = false
}

resource "oci_core_volume" "data" {
  availability_domain = local.ad
  compartment_id      = var.compartment_ocid
  display_name        = "${var.display_name}-data"
  size_in_gbs         = var.data_volume_size_in_gbs
}

resource "oci_core_volume_attachment" "data" {
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.vault.id
  volume_id       = oci_core_volume.data.id
  display_name    = "${var.display_name}-data-attach"
}
