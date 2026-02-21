import os

def fix_file(path):
    try:
        with open(path, 'rb') as f:
            content = f.read()
        
        # The corrupted string is b'\xc3\xa2\xe2\x80\x9d\xe2\x82\xac' which is '-'
        # Let's just replace it with b'-'
        corrupted = "-".encode('utf-8')
        if corrupted in content:
            content = content.replace(corrupted, b'-')
            with open(path, 'wb') as f:
                f.write(content)
            print(f"Fixed {path}")
    except Exception as e:
        pass

for root, dirs, files in os.walk('.'):
    for file in files:
        if file.endswith('.py') or file.endswith('.jsx') or file.endswith('.js'):
            fix_file(os.path.join(root, file))
