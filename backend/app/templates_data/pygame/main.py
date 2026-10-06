import pygame

pygame.init()
screen = pygame.display.set_mode((640, 480))
pygame.display.set_caption("Bouncing ball")
clock = pygame.time.Clock()

x, y, dx, dy, r = 320, 240, 4, 3, 20
running = True
print("Game is running: see the Display tab.")
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
    x += dx
    y += dy
    if x - r < 0 or x + r > 640:
        dx = -dx
    if y - r < 0 or y + r > 480:
        dy = -dy
    screen.fill((28, 35, 51))
    pygame.draw.circle(screen, (0, 121, 242), (x, y), r)
    pygame.display.flip()
    clock.tick(60)

pygame.quit()
