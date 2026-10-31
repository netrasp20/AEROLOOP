p="SetupSafety.test.tsx"; s=open(p).read()
s=s.replace('''        alt: field({ id: "RTL_ALT_M", supported: true, value: 15, name: "Altitude", units: "m" }),''',
'''        // ArduCopter publishes RTL_ALT_M with a 0.3 m minimum, so 0 ("return at
        // current altitude") is NOT a writable value on this firmware.
        alt: field({ id: "RTL_ALT_M", supported: true, value: 15, name: "Altitude", units: "m", min: 0.3, max: 3000, increment: 0.1 }),''')
open(p,"w").write(s)
print("fixture updated")
