#!/bin/bash
# Try to use the correct Node version from .nvmrc

# Check current Node version
CURRENT_NODE=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)

# If Node 25+, try to switch versions
if [ "$CURRENT_NODE" -ge 25 ] 2>/dev/null; then
  SWITCHED=false
  
  # Try fnm (Fast Node Manager)
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)" 2>/dev/null
    if fnm use 2>/dev/null; then
      SWITCHED=true
    else
      echo "Node 20 not installed. Installing via fnm..."
      fnm install 20 2>/dev/null && fnm use 20 2>/dev/null && SWITCHED=true
    fi
  # Try nvm
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh"
    if nvm use 2>/dev/null; then
      SWITCHED=true
    else
      echo "Node 20 not installed. Installing via nvm..."
      nvm install 20 2>/dev/null && nvm use 20 2>/dev/null && SWITCHED=true
    fi
  elif [ -s "$NVM_DIR/nvm.sh" ]; then
    source "$NVM_DIR/nvm.sh"
    if nvm use 2>/dev/null; then
      SWITCHED=true
    else
      echo "Node 20 not installed. Installing via nvm..."
      nvm install 20 2>/dev/null && nvm use 20 2>/dev/null && SWITCHED=true
    fi
  fi
  
  # Verify we switched versions
  if [ "$SWITCHED" = false ]; then
    NEW_NODE=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
    if [ "$NEW_NODE" -ge 25 ] 2>/dev/null; then
      echo "Error: Node version $(node --version) is not compatible with mint dev."
      echo "Please install and switch to Node 20:"
      echo "  If using fnm: fnm install 20 && fnm use 20"
      echo "  If using nvm: nvm install 20 && nvm use 20"
      exit 1
    fi
  fi
fi

# Run mint dev with any passed arguments
exec mint dev "$@"

