import javax.swing.*;
import java.awt.*;

public class Main {
    private static int count = 0;

    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            JFrame frame = new JFrame("Hello, Swing!");
            frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
            frame.setSize(320, 200);

            JLabel label = new JLabel("Clicked 0 times", SwingConstants.CENTER);
            label.setFont(label.getFont().deriveFont(20f));
            JButton button = new JButton("Click me");
            button.addActionListener(e -> label.setText("Clicked " + (++count) + " times"));

            frame.setLayout(new BorderLayout(10, 10));
            frame.add(label, BorderLayout.CENTER);
            frame.add(button, BorderLayout.SOUTH);
            frame.setLocationRelativeTo(null);
            frame.setVisible(true);
            System.out.println("Window is open: see the Display tab.");
        });
    }
}
