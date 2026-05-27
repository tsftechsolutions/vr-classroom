For Audio enable in chrome browser with Andriod phone:

If you're on Android and prefer not to use a tunnel at all, there's a simpler option — just tell Chrome to allow mic on your local IP:
On your phone, open Chrome and go to: chrome://flags
Search for "Insecure origins treated as secure"
Add http://10.0.0.73:3000 to the list
Tap Relaunch
Now open http://10.0.0.73:3000 — mic permission will work
This is the cleanest option since it needs no external service and works permanently for your local network testing.

For all other phones:
 npx localtunnel --port 3000


 # Find the process (shows PID)
Get-Process -Name node

# Kill by process name (stops all node processes)
Stop-Process -Name node -Force

# Or kill by specific PID
Stop-Process -Id <PID> -Force
In Command Prompt / Git Bash:


# Find node processes
tasklist | findstr node

# Kill by PID
taskkill /PID <PID> /F

# Kill all node processes
taskkill /IM node.exe /F
If it's running on a specific port (e.g., port 3000):


# Find what's using the port
netstat -ano | findstr :3000

# Kill by the PID shown in the last column
Stop-Process -Id <PID> -Force
The most common case is just Ctrl + C in the terminal where it's running.