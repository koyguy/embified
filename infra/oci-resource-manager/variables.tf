variable "compartment_ocid" {
  type        = string
  description = "Compartment OCID for the vault VM, VCN, and data volume."
}

variable "region" {
  type        = string
  description = "OCI region (use your tenancy home region for Always Free)."
  default     = "ap-hyderabad-1"
}

variable "availability_domain" {
  type        = string
  description = "AD name; empty uses the first AD in the region."
  default     = ""
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key for the ubuntu user."
}

variable "display_name" {
  type        = string
  description = "Name prefix for instance / VCN / volume."
  default     = "embified-vault"
}

variable "shape" {
  type        = string
  description = "Compute shape (A1.Flex preferred on Always Free)."
  default     = "VM.Standard.A1.Flex"
}

variable "ocpus" {
  type        = number
  description = "OCPUs for Flex shapes."
  default     = 1
}

variable "memory_in_gbs" {
  type        = number
  description = "Memory (GB) for Flex shapes."
  default     = 6
}

variable "boot_volume_size_in_gbs" {
  type        = number
  description = "Boot volume size (Always Free budget is shared with block)."
  default     = 47
}

variable "data_volume_size_in_gbs" {
  type        = number
  description = "Data block volume size mounted at /data."
  default     = 150
}

variable "assign_public_ip" {
  type        = bool
  default     = true
}

variable "embified_git_url" {
  type    = string
  default = "https://github.com/koyguy/embified.git"
}

variable "embified_git_ref" {
  type    = string
  default = "main"
}

variable "allowed_ssh_cidr" {
  type    = string
  default = "0.0.0.0/0"
}

variable "allowed_http_cidr" {
  type    = string
  default = "0.0.0.0/0"
}
