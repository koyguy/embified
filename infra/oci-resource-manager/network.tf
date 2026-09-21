resource "oci_core_vcn" "vault" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.display_name}-vcn"
  cidr_blocks    = ["10.0.0.0/16"]
  dns_label      = "embified"
}

resource "oci_core_internet_gateway" "vault" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vault.id
  display_name   = "${var.display_name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vault.id
  display_name   = "${var.display_name}-public-rt"

  route_rules {
    network_entity_id = oci_core_internet_gateway.vault.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

resource "oci_core_security_list" "vault" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vault.id
  display_name   = "${var.display_name}-sl"

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  ingress_security_rules {
    protocol = "6"
    source   = var.allowed_ssh_cidr
    tcp_options {
      min = 22
      max = 22
    }
  }

  ingress_security_rules {
    protocol = "6"
    source   = var.allowed_http_cidr
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol = "1"
    source   = "0.0.0.0/0"
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.vault.id
  display_name               = "${var.display_name}-public"
  cidr_block                 = "10.0.1.0/24"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.vault.id]
  prohibit_public_ip_on_vnic = false
  dns_label                  = "public"
}
