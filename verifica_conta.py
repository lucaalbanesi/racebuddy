import sys,re,json
h=open(sys.argv[1],encoding='utf-8',errors='ignore').read()
m=re.search(r'only (\d+) remaining anonymous',h)
n=re.search(r'const json=(\{.*\});\s*$',h,re.M)
k=len(json.loads(n.group(1))['data']['results']) if n else 'nessun json'
print('rimaste:', m.group(1) if m else 'nessun avviso', '· risultati:', k)
