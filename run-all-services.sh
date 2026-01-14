# run-all-services.sh
#!/bin/bash

# Color codes for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get the directory wheres this script is located
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Services to run
SERVICES=(
  "api-gateway"
  "services/admin-service"
  "services/agent-service"
  "services/auth-service"
  "services/matchmaking-service"
  "services/notification-service"
  "services/payment-service"
  "services/player-service"
  "services/tournament-service"
  "services/revenue-analytics-service"
  "services/wallet-service"
)

# Function to start a service
start_service() {
  local service_path=$1
  local service_name=$(basename "$service_path")
  local service_dir="$BACKEND_DIR/$service_path"

  if [ ! -d "$service_dir" ]; then
    echo -e "${RED}✗ Service directory not found: $service_dir${NC}"
    return 1
  fi

  if [ ! -f "$service_dir/package.json" ]; then
    echo -e "${RED}✗ package.json not found in $service_dir${NC}"
    return 1
  fi

  echo -e "${BLUE}Starting $service_name...${NC}"
  
  # Install dependencies if node_modules doesn't exist
  if [ ! -d "$service_dir/node_modules" ]; then
    echo -e "${BLUE}Installing dependencies for $service_name...${NC}"
    (cd "$service_dir" && npm install)
  fi

  # Start the service in the background using nohup to avoid buffering
  nohup bash -c "cd '$service_dir' && npm start" > /home/masanja/.gemini/tmp/b3df4e6581e1a3d5261ad01607890ec8b245e90d66dceb1918fbcdcb0f2f3eb6/${service_name}.log 2>&1 &
  local pid=$!
  local pgid=$(ps -o pgid= $pid | grep -o '[0-9]*')
  echo "DEBUG: Captured PID $pid and PGID $pgid for $service_name"
  
  # Store the PID and PGID immediately
  echo "$pid" > "/home/masanja/.gemini/tmp/b3df4e6581e1a3d5261ad01607890ec8b245e90d66dceb1918fbcdcb0f2f3eb6/${service_name}.pid"
  echo "$pgid" > "/home/masanja/.gemini/tmp/b3df4e6581e1a3d5261ad01607890ec8b245e90d66dceb1918fbcdcb0f2f3eb6/${service_name}.pgid"
  
  # Give the service a few seconds to start up
  sleep 1
  
  # Check if the process is still running
  if kill -0 $pid 2>/dev/null; then
    echo -e "${GREEN}✓ $service_name started (PID: $pid)${NC}"
    return 0
  else
    # Process died quickly, it probably failed to start
    echo -e "${RED}✗ Failed to start $service_name (see /home/masanja/.gemini/tmp/b3df4e6581e1a3d5261ad01607890ec8b245e90d66dceb1918fbcdcb0f2f3eb6/${service_name}.log)${NC}"
    return 1
  fi
}

# Function to stop all services
stop_all() {
  echo -e "${BLUE}Stopping all services...${NC}"
  for service_path in "${SERVICES[@]}"; do
    local service_name=$(basename "$service_path")
    local pid_file="/home/masanja/.gemini/tmp/b3df4e6581e1a3d5261ad01607890ec8b245e90d66dceb1918fbcdcb0f2f3eb6/${service_name}.pid"
    local pgid_file="/home/masanja/.gemini/tmp/b3df4e6581e1a3d5261ad01607890ec8b245e90d66dceb1918fbcdcb0f2f3eb6/${service_name}.pgid"
    
    echo "DEBUG: Checking service: $service_name"
    echo "DEBUG: pid_file: $pid_file"
    echo "DEBUG: pgid_file: $pgid_file"

    if [ -f "$pgid_file" ]; then
      local pgid=$(cat "$pgid_file")
      echo "DEBUG: Found PGID $pgid for $service_name"
      if kill -0 -- -"$pgid" 2>/dev/null; then
        echo "DEBUG: PGID $pgid is active, killing..."
        kill -9 -- -"$pgid"
        echo -e "${GREEN}✓ Stopped $service_name (PGID: $pgid)${NC}"
      else
        echo "DEBUG: PGID $pgid not active."
      fi
      rm "$pgid_file"
    elif [ -f "$pid_file" ]; then # Fallback for old pid files
      local pid=$(cat "$pid_file")
      echo "DEBUG: Found PID $pid for $service_name (fallback)"
      if kill -0 $pid 2>/dev/null; then
        echo "DEBUG: PID $pid is active (fallback), killing..."
        kill -9 $pid
        echo -e "${GREEN}✓ Stopped $service_name (PID: $pid) (fallback)${NC}"
      else
        echo "DEBUG: PID $pid not active (fallback)."
      fi
    fi
    [ -f "$pid_file" ] && rm "$pid_file" # Remove pid file if it exists
  done
}

# Function to show service status
show_status() {
  echo -e "${BLUE}Service Status:${NC}"
  for service_path in "${SERVICES[@]}"; do
    local service_name=$(basename "$service_path")
    local pid_file="/home/masanja/.gemini/tmp/b3df4e6581e1a3d5261ad01607890ec8b245e90d66dceb1918fbcdcb0f2f3eb6/${service_name}.pid"
    
    if [ -f "$pid_file" ]; then
      local pid=$(cat "$pid_file")
      if kill -0 $pid 2>/dev/null; then
        echo -e "${GREEN}✓ $service_name (PID: $pid)${NC}"
      else
        echo -e "${RED}✗ $service_name (PID: $pid - not running)${NC}"
        rm "$pid_file"
      fi
    else
      echo -e "${RED}✗ $service_name (not started)${NC}"
    fi
  done
}

# Function to show logs
show_logs() {
  local service_name=$1
  local log_file="/home/masanja/.gemini/tmp/b3df4e6581e1a3d5261ad01607890ec8b245e90d66dceb1918fbcdcb0f2f3eb6/${service_name}.log"
  
  if [ -f "$log_file" ]; then
    echo -e "${BLUE}Logs for $service_name:${NC}"
    tail -f "$log_file"
  else
    echo -e "${RED}No log file found for $service_name${NC}"
  fi
}

# Main script logic
case "${1:-start}" in
  start)
    stop_all
    sleep 2
    echo -e "${BLUE}Starting all services...${NC}"
    for service_path in "${SERVICES[@]}"; do
      start_service "$service_path"
      sleep 2
    done
    echo -e "${GREEN}All services started!${NC}"
    show_status
    ;;
  stop)
    stop_all
    ;;
  status)
    show_status
    ;;
  restart)
    stop_all
    sleep 2
    echo -e "${BLUE}Starting all services...${NC}"
    for service_path in "${SERVICES[@]}"; do
      start_service "$service_path"
      sleep 2
    done
    echo -e "${GREEN}All services restarted!${NC}"
    show_status
    ;;
  logs)
    if [ -z "$2" ]; then
      echo "Usage: $0 logs <service_name>"
      echo "Available services:"
      for service_path in "${SERVICES[@]}"; do
        echo "  - $(basename "$service_path")"
      done
    else
      show_logs "$2"
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs <service_name>}"
    echo ""
    echo "Commands:"
    echo "  start          - Start all services"
    echo "  stop           - Stop all services"
    echo "  restart        - Restart all services"
    echo "  status         - Show service status"
    echo "  logs <service> - Show logs for a specific service"
    echo ""
    echo "Examples:"
    echo "  $0 start"
    echo "  $0 status"
    echo "  $0 logs api-gateway"
    exit 1
    ;;
esac
