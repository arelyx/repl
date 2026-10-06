import tkinter as tk

root = tk.Tk()
root.title("Counter")
root.geometry("320x200")

count = tk.IntVar(value=0)

tk.Label(root, text="Hello, Tkinter!", font=("DejaVu Sans", 16)).pack(pady=10)
tk.Label(root, textvariable=count, font=("DejaVu Sans", 32, "bold")).pack()

buttons = tk.Frame(root)
buttons.pack(pady=10)
tk.Button(buttons, text="-1", width=6, command=lambda: count.set(count.get() - 1)).pack(side="left", padx=5)
tk.Button(buttons, text="+1", width=6, command=lambda: count.set(count.get() + 1)).pack(side="left", padx=5)

print("Window is open: see the Display tab.")
root.mainloop()
