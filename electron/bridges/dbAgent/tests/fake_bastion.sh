#!/bin/sh
# A bastion's host picker: ask for an address, list the accounts on it, ask
# which one, then hand over to that host's shell. Prompts end without a line
# break and the address is rejected when unknown, like the real thing.
printf '\033[2J\033[H'
echo "============ Operation Bastion ============"
printf '\350\257\267\350\276\223\345\205\245IP: '
read -r address
if [ "$address" != "192.0.2.14" ]; then
  echo "host $address not found"
  exit 1
fi
echo " 1: appuser"
echo " 2: root"
printf 'Select account [1-2]: '
read -r choice
if [ "$choice" != "1" ]; then
  echo "permission denied for selection $choice"
  exit 1
fi
echo "Last login: Sat Nov 14 13:00:00 2026 from bastion"
echo "You have new mail in /var/spool/mail/appuser"
PS1='[host-192-0-2-14@appuser]/appuser$' exec bash --noprofile --norc -i
