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